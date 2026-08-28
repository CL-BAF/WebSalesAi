import type { Database } from '../db/database.js';
import type { LeadRepository, LeadRecord } from '../db/repositories/leads.js';
import type { SuppressionRepository } from '../db/repositories/suppressions.js';
import type { WorkflowEngine, TransitionContext } from '../engine/workflowEngine.js';
import type { WorkflowJobRecord } from '../db/repositories/workflowJobs.js';
import { ValidationError } from '../domain/errors.js';
import { fetchSafeText, htmlToText, type FetchSafeOptions } from '../net/fetchSafe.js';
import type { ResearcherAgent } from './researcher.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AuditEventRepository } from '../db/repositories/auditEvents.js';

export interface ImportLeadInput {
  businessName: string;
  industry?: string;
  description?: string;
  source: string;
  websiteUrl?: string;
  contactName?: string;
  contactEmail?: string;
  contactSource?: string;
  discoveryDetail?: string;
  selectionReason: string;
}

export type ImportOutcome =
  | { outcome: 'imported'; lead: LeadRecord; job: WorkflowJobRecord }
  | { outcome: 'duplicate'; lead: LeadRecord; reason: string }
  | { outcome: 'suppressed'; reason: string };

export type ResearchOutcome =
  | { outcome: 'qualified'; job: WorkflowJobRecord; dossier: Record<string, unknown> }
  | { outcome: 'rejected'; job: WorkflowJobRecord; dossier: Record<string, unknown> }
  | { outcome: 'failed'; job: WorkflowJobRecord; error: string };

export interface LeadServiceDeps {
  db: Database;
  leads: LeadRepository;
  suppressions: SuppressionRepository;
  engine: WorkflowEngine;
  audit: AuditEventRepository;
  researcher: ResearcherAgent;
  config: Pick<AppConfig, 'fetchTimeoutMs' | 'fetchMaxBytes' | 'outreach'>;
  log: Logger;
  /** Overridable for tests. */
  fetchWebsiteText?: (url: string, opts: FetchSafeOptions) => Promise<string>;
}

const SYSTEM: TransitionContext = { actor: 'system', actorType: 'system' };

export class LeadService {
  private readonly fetchWebsiteText: (url: string, opts: FetchSafeOptions) => Promise<string>;

  constructor(private readonly deps: LeadServiceDeps) {
    this.fetchWebsiteText =
      deps.fetchWebsiteText ??
      (async (url, opts) => htmlToText((await fetchSafeText(url, opts)).text));
  }

  /**
   * Imports a lead from a discovery source. Deduplicates by website and
   * enforces the suppression list (email and domain, including parent
   * domain). Audit events record WHY each lead was accepted or refused.
   */
  importLead(input: ImportLeadInput, actor = 'owner'): ImportOutcome {
    if (!input.businessName.trim()) throw new ValidationError('businessName is required');
    if (!input.source.trim()) throw new ValidationError('discovery source is required');

    if (input.contactEmail && this.deps.suppressions.isSuppressedEmail(input.contactEmail)) {
      this.deps.audit.append({ actor, actorType: 'owner', action: 'lead.suppressed', details: { businessName: input.businessName, contactEmail: input.contactEmail, source: input.source } });
      return { outcome: 'suppressed', reason: `contact email ${input.contactEmail} is on the suppression list` };
    }
    if (input.websiteUrl && this.deps.suppressions.isSuppressedDomain(input.websiteUrl)) {
      this.deps.audit.append({ actor, actorType: 'owner', action: 'lead.suppressed', details: { businessName: input.businessName, websiteUrl: input.websiteUrl, source: input.source } });
      return { outcome: 'suppressed', reason: `website domain is on the suppression list` };
    }

    const existing = input.websiteUrl ? this.deps.leads.tryGetByWebsite(input.websiteUrl) : undefined;
    if (existing) {
      this.deps.audit.append({ actor, actorType: 'owner', action: 'lead.duplicate_skipped', leadId: existing.id, details: { websiteUrl: input.websiteUrl, source: input.source } });
      return { outcome: 'duplicate', lead: existing, reason: 'a lead with this website already exists' };
    }

    const { lead } = this.deps.leads.createLead(
      {
        businessName: input.businessName.trim(),
        industry: input.industry,
        description: input.description,
        source: input.source.trim(),
        websiteUrl: input.websiteUrl?.trim() || undefined,
        contactName: input.contactName,
        contactEmail: input.contactEmail?.trim().toLowerCase() || undefined,
        contactSource: input.contactSource,
        discoveryDetail: input.discoveryDetail,
        selectionReason: input.selectionReason,
      },
    );
    const job = this.deps.engine.getOrCreateJobForLead(lead.id, actor);
    this.deps.audit.append({
      actor,
      actorType: 'owner',
      action: 'lead.imported',
      leadId: lead.id,
      jobId: job.id,
      details: { businessName: input.businessName, source: input.source, selectionReason: input.selectionReason, websiteUrl: lead.websiteUrl },
    });
    return { outcome: 'imported', lead, job };
  }

  /**
   * Runs the Researcher on a lead: LEAD_DISCOVERED -> RESEARCHING ->
   * READY_FOR_OUTREACH | LEAD_REJECTED (or FAILED on unrecoverable errors —
   * retryable). Website content is fetched SSRF-guarded and handed to the
   * agent as wrapped untrusted data.
   */
  async researchLead(leadId: string, ctx: TransitionContext = SYSTEM): Promise<ResearchOutcome> {
    const { engine, leads } = this.deps;
    const lead = leads.requireLead(leadId);
    const job = engine.getOrCreateJobForLead(leadId);

    let websiteText: string | null = null;
    if (lead.websiteUrl) {
      try {
        websiteText = await this.fetchWebsiteText(lead.websiteUrl, {
          timeoutMs: this.deps.config.fetchTimeoutMs,
          maxBytes: this.deps.config.fetchMaxBytes,
        });
      } catch (err) {
        this.deps.audit.append({
          actor: ctx.actor,
          actorType: ctx.actorType,
          action: 'research.failed',
          leadId,
          jobId: job.id,
          details: { stage: 'website_fetch', note: 'continuing without website content', error: err instanceof Error ? err.message : String(err) },
        });
        this.deps.log.warn({ leadId, error: err instanceof Error ? err.message : String(err) }, 'website fetch failed; researching without site content');
        websiteText = null;
      }
    }

    // Enter RESEARCHING unless we are already there (idempotent retry).
    const current = this.deps.engine.getOrCreateJobForLead(leadId);
    if (current.state !== 'RESEARCHING') {
      engine.transition(job.id, 'RESEARCHING', ctx);
    }

    try {
      const business = leads.requireBusiness(lead.businessId);
      const research = await this.deps.researcher.research({
        jobId: job.id,
        businessName: business.name,
        industry: business.industry,
        discoverySource: lead.discoverySource,
        discoveryDetail: lead.discoveryDetail,
        websiteUrl: lead.websiteUrl,
        websiteText,
        contactEmail: lead.contactEmail,
      });
      const dossier = research.dossier;
      this.deps.leads.updateResearch(leadId, {
        score: dossier.score,
        confidence: dossier.confidence,
        dossierJson: JSON.stringify(dossier),
      });
      this.deps.audit.append({
        actor: `agent:researcher`,
        actorType: 'agent',
        action: 'research.completed',
        leadId,
        jobId: job.id,
        details: { score: dossier.score, confidence: dossier.confidence, recommendForOutreach: dossier.recommendForOutreach, model: research.model, attempts: research.attempts },
      });

      const qualified = dossier.recommendForOutreach && dossier.score >= this.deps.config.outreach.minScore;
      const next = engine.transition(job.id, qualified ? 'READY_FOR_OUTREACH' : 'LEAD_REJECTED', {
        actor: 'system',
        actorType: 'system',
        reason: qualified
          ? `researcher recommendation (score ${dossier.score} >= ${this.deps.config.outreach.minScore})`
          : `researcher rejection: ${(dossier.rejectionReasons ?? []).join('; ') || 'recommendForOutreach=false'}`,
      });
      return { outcome: qualified ? 'qualified' : 'rejected', job: next.job, dossier: dossier as unknown as Record<string, unknown> };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = engine.transition(job.id, 'FAILED', { actor: 'system', actorType: 'system', reason: `research failed: ${message}` });
      this.deps.audit.append({
        actor: 'system',
        actorType: 'system',
        action: 'research.failed',
        leadId,
        jobId: job.id,
        details: { error: message },
      });
      return { outcome: 'failed', job: failed.job, error: message };
    }
  }
}
