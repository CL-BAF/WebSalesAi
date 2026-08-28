import path from 'node:path';
import { ValidationError } from '../domain/errors.js';
import type { DeploymentProvider } from './deploymentProvider.js';
import type { DeploymentRepository } from '../db/repositories/deployments.js';
import type { LeadRepository } from '../db/repositories/leads.js';
import type { WebsiteProjectRepository } from '../db/repositories/websiteProjects.js';
import type { WorkflowJobRepository } from '../db/repositories/workflowJobs.js';
import type { ReviewRepository } from '../db/repositories/reviews.js';
import type { IdempotencyRepository } from '../db/repositories/idempotency.js';
import type { WorkflowEngine } from '../engine/workflowEngine.js';
import type { AuditEventRepository } from '../db/repositories/auditEvents.js';
import type { OutreachService } from '../outreach/outreachService.js';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export interface DeploymentServiceDeps {
  config: AppConfig;
  db: Database;
  leads: LeadRepository;
  jobs: WorkflowJobRepository;
  projects: WebsiteProjectRepository;
  deployments: DeploymentRepository;
  reviews: ReviewRepository;
  idempotency: IdempotencyRepository;
  engine: WorkflowEngine;
  audit: AuditEventRepository;
  previewProvider: DeploymentProvider;
  productionProvider: DeploymentProvider;
  /** Injected so the service can verify payment without owning payments. */
  isPaymentConfirmed?: (jobId: string) => boolean;
  outreach: OutreachService;
  log: Logger;
}

export interface PreviewResult {
  deployed: boolean;
  url?: string;
  sent?: boolean;
  blockedReason?: string;
}

const SYSTEM = { actor: 'system', actorType: 'system' as const };

/**
 * Deployment stage. Preview and production are separate operations:
 *  - deployPreview: PREVIEW_READY → deploy → send link → PREVIEW_SENT →
 *    AWAITING_CLIENT_APPROVAL. Uses the email guard stack for the link send.
 *  - deployProduction: READY_FOR_PRODUCTION only (the state machine already
 *    guarantees review PASS + client approval + payment), PLUS a defense-
 *    in-depth re-verification of review PASS and payment confirmation here.
 *    The LLM cannot trigger this: engine actor rules restrict the production
 *    edges to system/owner, and this service runs as system on a state path
 *    that only deterministic code can reach.
 */
export class DeploymentService {
  constructor(private readonly deps: DeploymentServiceDeps) {}

  async deployAndSendPreview(jobId: string): Promise<PreviewResult> {
    const job = this.deps.jobs.requireById(jobId);
    if (!job.leadId) throw new ValidationError('preview deployment requires a lead');
    const project = this.deps.projects.requireByJobId(jobId);

    const idempotencyKey = `deploy:preview:${jobId}`;
    const claim = this.deps.idempotency.claim(idempotencyKey, 'deployment');
    if (!claim.fresh) {
      // M7-1: replay. If the link was never delivered (job still
      // PREVIEW_READY), re-attempt the send through the fresh guard stack —
      // the outreach reply key was released on the earlier block, so the
      // retry re-runs guards honestly. sent:true only when a send succeeded.
      const cached = claim.result as { url: string } | undefined;
      if (!cached?.url) {
        return { deployed: true, sent: false, blockedReason: 'deployment incomplete; retry pending' };
      }
      if (job.state === 'PREVIEW_READY') {
        const retried = await this.attemptPreviewSend(job, cached.url);
        return { deployed: true, url: cached.url, sent: retried.sent, blockedReason: retried.sent ? undefined : retried.reason };
      }
      return { deployed: true, url: cached.url, sent: true };
    }
    // Fresh claim: state must still be PREVIEW_READY.
    if (job.state !== 'PREVIEW_READY') {
      this.deps.idempotency.release(idempotencyKey);
      throw new ValidationError(`preview deployment requires PREVIEW_READY state, job is ${job.state}`);
    }
    const lead = this.deps.leads.requireLead(job.leadId);
    const workspaceRoot = project.workspacePath;

    let url: string;
    try {
      this.deps.db.transaction(() => {
        this.deps.deployments.open({
          jobId,
          projectId: project.id,
          kind: 'preview',
          provider: this.deps.previewProvider.name,
          idempotencyKey,
        });
      });
      const result = await this.deps.previewProvider.deploy({
        sourceDir: workspaceRoot,
        jobId,
        kind: 'preview',
        idempotencyKey,
      });
      url = result.url;
      this.deps.db.transaction(() => {
        this.deps.deployments.complete(idempotencyKey, result.url, result.providerReference);
        this.deps.idempotency.complete(idempotencyKey, { url: result.url });
        this.deps.audit.append({
          actor: 'system',
          actorType: 'system',
          action: 'preview.deployed',
          jobId,
          leadId: job.leadId,
          details: { provider: result.provider, url: result.url },
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.db.transaction(() => this.deps.deployments.fail(idempotencyKey, message));
      this.deps.idempotency.release(idempotencyKey);
      throw err;
    }

    // Send the customer the private preview link. The body is deterministic
    // application text (never LLM-generated); the email guard stack applies.
    const send = await this.attemptPreviewSend(job, url);
    if (!send.sent) {
      // Deployment exists; the link send was guard-blocked. State stays
      // PREVIEW_READY so the send can be retried later (M7-1 replay path).
      return { deployed: true, url, sent: false, blockedReason: send.reason };
    }
    return { deployed: true, url, sent: true };
  }

  /** Sends the preview link and advances the state on success. */
  private async attemptPreviewSend(
    job: { id: string; leadId: string },
    url: string,
  ): Promise<{ sent: boolean; reason?: string }> {
    const subject = 'Your website preview is ready';
    const body = [
      'Hello,',
      '',
      'Your website preview is ready for review:',
      url,
      '',
      'Please take a look and let us know if you would like any changes, or reply to approve the site as-is.',
      '',
      '— WebSalesAi Website Service',
    ].join('\n');
    const send = await this.deps.outreach.sendConversationReply(job.leadId, subject, body);
    if (!send.sent) {
      return { sent: false, reason: send.reason };
    }
    this.deps.audit.append({
      actor: 'system',
      actorType: 'system',
      action: 'preview.sent',
      jobId: job.id,
      leadId: job.leadId,
      details: { url },
    });
    // State: PREVIEW_READY → PREVIEW_SENT → AWAITING_CLIENT_APPROVAL.
    this.deps.engine.transition(job.id, 'PREVIEW_SENT', { actor: 'system', actorType: 'system', reason: 'preview link delivered' });
    this.deps.engine.transition(job.id, 'AWAITING_CLIENT_APPROVAL', { actor: 'system', actorType: 'system', reason: 'awaiting customer review of preview' });
    return { sent: true };
  }

  async deployProduction(jobId: string): Promise<{ deployed: boolean; url?: string; reason?: string }> {
    const job = this.deps.jobs.requireById(jobId);

    const idempotencyKey = `deploy:production:${jobId}`;
    const claim = this.deps.idempotency.claim(idempotencyKey, 'deployment');
    if (!claim.fresh) {
      const cached = claim.result as { url: string } | undefined;
      return cached?.url ? { deployed: true, url: cached.url } : { deployed: false, reason: 'already deployed' };
    }
    // Fresh claim: state must still be READY_FOR_PRODUCTION.
    if (job.state !== 'READY_FOR_PRODUCTION') {
      this.deps.idempotency.release(idempotencyKey);
      throw new ValidationError(`production deployment requires READY_FOR_PRODUCTION state, job is ${job.state}`);
    }

    // Defense-in-depth guard #1: an actual review PASS must exist.
    const reviews = this.deps.reviews.listByJob(jobId);
    if (!reviews.some((r) => r.verdict === 'PASS')) {
      this.deps.idempotency.release(idempotencyKey);
      this.deps.audit.append({ actor: 'system', actorType: 'system', action: 'production.deploy_requested', jobId, details: { refused: 'no review PASS on record' } });
      return { deployed: false, reason: 'no review PASS on record' };
    }

    // Defense-in-depth guard #2: payment confirmation (owner can disable via
    // authorised configuration; the flag is fail-closed by default).
    if (this.deps.config.requirePaymentForProduction) {
      const paid = this.deps.isPaymentConfirmed?.(jobId) ?? false;
      if (!paid) {
        this.deps.idempotency.release(idempotencyKey);
        this.deps.audit.append({ actor: 'system', actorType: 'system', action: 'production.deploy_requested', jobId, details: { refused: 'payment not confirmed' } });
        return { deployed: false, reason: 'payment not confirmed' };
      }
    }

    const project = this.deps.projects.requireByJobId(jobId);

    try {
      this.deps.db.transaction(() => {
        this.deps.deployments.open({
          jobId,
          projectId: project.id,
          kind: 'production',
          provider: this.deps.productionProvider.name,
          idempotencyKey,
        });
      });
      const result = await this.deps.productionProvider.deploy({
        sourceDir: project.workspacePath,
        jobId,
        kind: 'production',
        idempotencyKey,
      });
      this.deps.db.transaction(() => {
        this.deps.deployments.complete(idempotencyKey, result.url, result.providerReference);
        this.deps.idempotency.complete(idempotencyKey, { url: result.url });
        this.deps.audit.append({
          actor: 'system',
          actorType: 'system',
          action: 'production.deployed',
          jobId,
          leadId: job.leadId,
          details: { provider: result.provider, url: result.url },
        });
      });

      // State: READY_FOR_PRODUCTION → DEPLOYING → COMPLETED (system actor;
      // agent actors are rejected by engine actor rules on these edges).
      this.deps.engine.transition(jobId, 'DEPLOYING', { actor: 'system', actorType: 'system', reason: 'production deployment starting' });
      this.deps.engine.transition(jobId, 'COMPLETED', { actor: 'system', actorType: 'system', reason: 'production site live' });
      return { deployed: true, url: result.url };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.db.transaction(() => this.deps.deployments.fail(idempotencyKey, message));
      this.deps.idempotency.release(idempotencyKey);
      this.deps.engine.transition(jobId, 'FAILED', { actor: 'system', actorType: 'system', reason: `production deployment failed: ${message}` });
      throw err;
    }
  }
}
