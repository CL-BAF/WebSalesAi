import path from 'node:path';
import { ValidationError } from '../domain/errors.js';
import { ReviewerAgent } from './reviewer.js';
import { runBuildChecks } from '../website/checks.js';
import { Workspace } from '../website/workspace.js';
import type { ResearcherDossier, ReviewerVerdict } from '../agents/schemas.js';
import type { LeadRepository } from '../db/repositories/leads.js';
import type { RequirementRepository } from '../db/repositories/requirements.js';
import type { WorkflowJobRepository } from '../db/repositories/workflowJobs.js';
import type { ReviewRepository, ReviewRecord } from '../db/repositories/reviews.js';
import type { WebsiteProjectRepository } from '../db/repositories/websiteProjects.js';
import type { WorkflowEngine } from '../engine/workflowEngine.js';
import type { AuditEventRepository } from '../db/repositories/auditEvents.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export type ReviewOutcome =
  | { outcome: 'passed'; verdict: ReviewerVerdict; review: ReviewRecord; jobState: string }
  | { outcome: 'revision_required'; verdict: ReviewerVerdict; review: ReviewRecord; jobState: string }
  | { outcome: 'human_review'; reason: string; jobState: string };

export interface ReviewServiceDeps {
  config: AppConfig;
  leads: LeadRepository;
  jobs: WorkflowJobRepository;
  requirements: RequirementRepository;
  reviews: ReviewRepository;
  projects: WebsiteProjectRepository;
  engine: WorkflowEngine;
  audit: AuditEventRepository;
  reviewer: ReviewerAgent;
  log: Logger;
}

const SYSTEM = { actor: 'system', actorType: 'system' as const };

/**
 * Independent Review stage with a bounded Builder/Reviewer loop:
 *   REVIEWING -> PREVIEW_READY (PASS)
 *   REVIEWING -> REVISION_REQUIRED (changes; cycles < max)
 *   REVIEWING -> NEEDS_HUMAN_REVIEW (changes; cycles would exceed max, or the
 *                review itself failed unrecoverably)
 * The loop is driven entirely by deterministic application code; the
 * Reviewer LLM cannot PASS over authoritative HIGH-severity deterministic
 * findings, and cannot trigger builds or deployments itself.
 */
export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  private workspaceFor(jobId: string): Workspace {
    return Workspace.open(path.resolve(this.deps.config.workspacesRoot), jobId, this.deps.config.execTimeoutMs);
  }

  async reviewSite(jobId: string, opts: { revisionCycle?: number } = {}): Promise<ReviewOutcome> {
    const { engine, jobs, leads } = this.deps;
    const revisionCycle = opts.revisionCycle ?? 0;
    const job = jobs.requireById(jobId);
    if (job.state !== 'REVIEWING') {
      throw new ValidationError(`review requires REVIEWING state, job is ${job.state}`);
    }
    const lead = leads.requireLead(job.leadId);
    const business = leads.requireBusiness(lead.businessId);
    const dossier = lead.dossierJson ? (JSON.parse(lead.dossierJson) as ResearcherDossier) : null;

    const workspace = this.workspaceFor(jobId);
    const files = workspace.readAllFiles();
    if (files.size === 0) {
      return this.toHumanReview(jobId, 'review found an empty or missing workspace');
    }
    const staticChecks = runBuildChecks(files);
    const staticFindings = staticChecks.findings.map((f) => ({
      category: f.category,
      severity: f.severity,
      description: f.description,
      file: f.file,
    }));

    let verdict: ReviewerVerdict;
    let reviewerRunId: string | null = null;
    try {
      const res = await this.deps.reviewer.review({
        jobId,
        businessName: business.name,
        dossier,
        requirements: this.deps.requirements.listByJob(jobId).map((r) => ({ category: r.category, title: r.title, detail: r.detail })),
        staticFindings,
        files,
        revisionCycle,
      });
      verdict = res.verdict;
      reviewerRunId = res.runId;
      this.deps.audit.append({
        actor: 'agent:reviewer',
        actorType: 'agent',
        action: 'agent.run_finished',
        jobId,
        leadId: lead.id,
        details: { purpose: 'reviewer:site_review', verdict: verdict.verdict, findings: verdict.findings.length, model: res.model, attempts: res.attempts },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.toHumanReview(jobId, `reviewer output invalid after bounded retries: ${message}`);
    }

    // Deterministic HIGH findings overrule a model PASS.
    const highStatic = staticFindings.filter((f) => f.severity === 'high');
    let effectiveVerdict: 'PASS' | 'CHANGES_REQUIRED' = verdict.verdict;
    if (verdict.verdict === 'PASS' && highStatic.length > 0) {
      effectiveVerdict = 'CHANGES_REQUIRED';
      verdict = {
        ...verdict,
        verdict: 'CHANGES_REQUIRED',
        findings: [
          ...verdict.findings,
          ...highStatic.map((f) => ({
            category: f.category as ReviewerVerdict['findings'][number]['category'],
            severity: 'high' as const,
            description: `deterministic check: ${f.description}`,
            file: f.file,
          })),
        ],
      };
      this.deps.audit.append({
        actor: 'system',
        actorType: 'system',
        action: 'review.failed',
        jobId,
        leadId: lead.id,
        details: { note: 'model PASS overruled by deterministic HIGH findings', count: highStatic.length },
      });
    }

    const cycleNumber = this.deps.reviews.nextCycle(jobId);
    // Artifact binding (entry criterion): a PASS binds to the exact workspace
    // state approved — git HEAD commit + content digest over all files.
    const artifactCommit = await workspace.headCommit();
    const artifactHash = workspace.contentDigest();
    const review = this.deps.reviews.record({
      jobId,
      projectId: this.deps.projects.requireByJobId(jobId).id,
      cycle: cycleNumber,
      verdict: effectiveVerdict,
      findings: verdict,
      reviewerRunId,
      artifactCommit,
      artifactHash,
    });
    this.deps.audit.append({
      actor: 'agent:reviewer',
      actorType: 'agent',
      action: 'review.completed',
      jobId,
      leadId: lead.id,
      details: { cycle: cycleNumber, verdict: effectiveVerdict, findings: verdict.findings.length, summary: verdict.summary.slice(0, 300) },
    });

    if (effectiveVerdict === 'PASS') {
      const result = engine.transition(jobId, 'PREVIEW_READY', {
        actor: 'system',
        actorType: 'system',
        reason: `review cycle ${cycleNumber} PASS`,
      });
      this.deps.projects.setStatus(jobId, 'in_review');
      return { outcome: 'passed', verdict, review, jobState: result.job.state };
    }

    const cycles = jobs.getRevisionCycles(jobId);
    if (cycles >= this.deps.config.reviewMaxCycles) {
      engine.transition(jobId, 'NEEDS_HUMAN_REVIEW', {
        actor: 'system',
        actorType: 'system',
        reason: `revision cycle limit ${this.deps.config.reviewMaxCycles} exhausted; latest verdict: ${verdict.summary.slice(0, 200)}`,
      });
      this.deps.audit.append({
        actor: 'system',
        actorType: 'system',
        action: 'human_review.requested',
        jobId,
        leadId: lead.id,
        details: { reason: 'revision cycle limit exhausted' },
      });
      return { outcome: 'human_review', reason: 'revision cycle limit exhausted', jobState: 'NEEDS_HUMAN_REVIEW' };
    }

    const next = engine.transition(jobId, 'REVISION_REQUIRED', {
      actor: 'system',
      actorType: 'system',
      reason: `review cycle ${cycleNumber} CHANGES_REQUIRED (${verdict.findings.length} finding(s))`,
    });
    jobs.incrementRevisionCycles(jobId);
    this.deps.projects.setStatus(jobId, 'revision_required');
    return { outcome: 'revision_required', verdict, review, jobState: next.job.state };
  }

  private toHumanReview(jobId: string, reason: string): ReviewOutcome {
    this.deps.engine.transition(jobId, 'NEEDS_HUMAN_REVIEW', { actor: 'system', actorType: 'system', reason });
    this.deps.audit.append({
      actor: 'system',
      actorType: 'system',
      action: 'human_review.requested',
      jobId,
      details: { reason },
    });
    return { outcome: 'human_review', reason, jobState: 'NEEDS_HUMAN_REVIEW' };
  }
}
