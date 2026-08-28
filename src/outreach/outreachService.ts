import { createHash } from 'node:crypto';
import { ExternalActionError, ValidationError } from '../domain/errors.js';
import { evaluateSendGuards, startOfUtcDay, type SendGuardVerdict } from './policy.js';
import type { EmailProvider } from './emailProvider.js';
import type { Database } from '../db/database.js';
import type { LeadRepository, LeadRecord } from '../db/repositories/leads.js';
import type { WorkflowJobRepository } from '../db/repositories/workflowJobs.js';
import type { SuppressionRepository } from '../db/repositories/suppressions.js';
import type { ConversationRepository } from '../db/repositories/conversations.js';
import type { OutreachRepository, OutreachDraftRecord } from '../db/repositories/outreach.js';
import type { SettingsRepository } from '../db/repositories/settings.js';
import { SETTING_KEYS } from '../db/repositories/settings.js';
import type { IdempotencyRepository } from '../db/repositories/idempotency.js';
import type { WorkflowEngine, TransitionContext } from '../engine/workflowEngine.js';
import type { AuditEventRepository } from '../db/repositories/auditEvents.js';
import type { SalesAgent } from '../crm/salesAgent.js';
import type { ResearcherDossier } from '../agents/schemas.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export type SendResult =
  | { sent: true; providerMessageId: string; fresh: boolean }
  | { sent: false; reason: string; fresh: false };

export interface OutreachServiceDeps {
  db: Database;
  leads: LeadRepository;
  jobs: WorkflowJobRepository;
  suppressions: SuppressionRepository;
  conversations: ConversationRepository;
  outreach: OutreachRepository;
  settings: SettingsRepository;
  idempotency: IdempotencyRepository;
  engine: WorkflowEngine;
  audit: AuditEventRepository;
  emailProvider: EmailProvider;
  salesAgent: SalesAgent;
  config: AppConfig;
  log: Logger;
  now?: () => Date;
}

const SYSTEM: TransitionContext = { actor: 'system', actorType: 'system' };
export const SENDER_IDENTITY = 'WebSalesAi Website Service';

/** Thrown inside the send transaction when a guard re-check fails. */
class SendBlockedError extends Error {
  constructor(readonly guard: string, readonly reason: string) {
    super(`send blocked by guard "${guard}": ${reason}`);
    this.name = 'SendBlockedError';
  }
}

/**
 * Outreach subsystem. Every outbound email — cold outreach AND conversation
 * replies — passes the same deterministic guard stack (policy.ts) before
 * reaching the provider, and is sent exactly-once via the idempotency layer
 * plus the outreach_log unique constraint.
 */
export class OutreachService {
  private readonly now: () => Date;
  private readonly db: Database;

  constructor(private readonly deps: OutreachServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.db = deps.db;
  }

  private killSwitch(): boolean {
    return this.deps.settings.getBool(SETTING_KEYS.outreachKillSwitch, this.deps.config.outreach.killSwitchInitial);
  }

  private paused(): boolean {
    return this.deps.settings.getBool(SETTING_KEYS.automationPaused, this.deps.config.automationPausedInitial);
  }

  private domainOf(lead: LeadRecord): string {
    try {
      return new URL(lead.websiteUrl ?? '').hostname.replace(/^www\./, '');
    } catch {
      return lead.websiteUrl ?? 'unknown';
    }
  }

  guardContext(lead: LeadRecord, now = this.now(), isReply = false): SendGuardVerdict {
    return evaluateSendGuards({
      killSwitch: this.killSwitch(),
      automationPaused: this.paused(),
      outreachEnabled: this.deps.config.outreach.enabled,
      emailSuppressed: lead.contactEmail ? this.deps.suppressions.isSuppressedEmail(lead.contactEmail) : false,
      domainSuppressed: lead.websiteUrl ? this.deps.suppressions.isSuppressedDomain(lead.websiteUrl) : false,
      sentToday: this.deps.outreach.countSince(this.deps.emailProvider.name, startOfUtcDay(now)),
      sentToDomainToday: lead.websiteUrl
        ? this.deps.outreach.countForDomainSince(this.domainOf(lead), startOfUtcDay(now))
        : 0,
      lastSentToContactAt: lead.contactEmail ? this.deps.outreach.lastSentToContact(lead.contactEmail) : undefined,
      now,
      isReply,
      limits: {
        maxPerDay: this.deps.config.outreach.maxPerDay,
        maxPerDomainPerDay: this.deps.config.outreach.maxPerDomainPerDay,
        cooldownHours: this.deps.config.outreach.cooldownHours,
      },
    });
  }

  /** Sales agent drafts outreach for a qualified lead. */
  async draftOutreach(
    leadId: string,
    actor: TransitionContext = SYSTEM,
  ): Promise<{ draft: OutreachDraftRecord; awaitingApproval: boolean }> {
    const job = this.deps.engine.getOrCreateJobForLead(leadId);
    if (job.state !== 'READY_FOR_OUTREACH') {
      throw new ValidationError(`cannot draft outreach for job in state ${job.state}`);
    }
    const lead = this.deps.leads.requireLead(leadId);
    if (!lead.contactEmail) {
      throw new ValidationError('lead has no verified contact email; cannot draft outreach');
    }
    if (!lead.dossierJson) {
      throw new ValidationError('lead has no research dossier; run research first');
    }
    const dossier = JSON.parse(lead.dossierJson) as ResearcherDossier;

    const res = await this.deps.salesAgent.draftOutreach({
      jobId: job.id,
      businessName: this.deps.leads.requireBusiness(lead.businessId).name,
      dossier,
      senderIdentity: SENDER_IDENTITY,
    });
    const draft = this.deps.outreach.createDraft(job.id, res.draft.subject, res.draft.body);
    this.deps.audit.append({
      actor: 'agent:sales',
      actorType: 'agent',
      action: 'outreach.drafted',
      jobId: job.id,
      leadId,
      details: { draftId: draft.id, subject: draft.subject, model: res.model, attempts: res.attempts },
    });

    if (this.deps.config.outreach.requireApproval) {
      this.deps.engine.transition(job.id, 'AWAITING_OUTREACH_APPROVAL', actor);
      return { draft, awaitingApproval: true };
    }
    return { draft, awaitingApproval: false };
  }

  /** Owner approves a pending draft; the send then runs the guard stack. */
  async approveDraft(draftId: string, decidedBy: string): Promise<SendResult> {
    const draft = this.deps.outreach.requireDraft(draftId);
    if (draft.status !== 'pending') throw new ValidationError(`draft ${draftId} is not pending`);
    this.deps.outreach.decideDraft(draftId, 'approved', decidedBy);
    const job = this.deps.jobs.requireById(draft.jobId);
    this.deps.audit.append({
      actor: decidedBy,
      actorType: 'owner',
      action: 'outreach.approved',
      jobId: draft.jobId,
      leadId: job.leadId,
      details: { draftId },
    });
    return this.sendDraft(draft);
  }
  /** Owner rejects: draft marked rejected; lead returns to READY_FOR_OUTREACH. */
  rejectDraft(draftId: string, decidedBy: string): { done: true } {
    const draft = this.deps.outreach.requireDraft(draftId);
    if (draft.status !== 'pending') throw new ValidationError(`draft ${draftId} is not pending`);
    this.deps.outreach.decideDraft(draftId, 'rejected', decidedBy);
    const job = this.deps.jobs.requireById(draft.jobId);
    this.deps.audit.append({
      actor: decidedBy,
      actorType: 'owner',
      action: 'outreach.rejected',
      jobId: draft.jobId,
      leadId: job.leadId,
      details: { draftId },
    });
    if (job.state === 'AWAITING_OUTREACH_APPROVAL') {
      this.deps.engine.transition(draft.jobId, 'READY_FOR_OUTREACH', {
        actor: decidedBy,
        actorType: 'owner',
        reason: 'draft rejected; a new draft may be requested',
      });
    }
    return { done: true };
  }

  /**
   * Sends an approved draft through the full guard stack. The provider call,
   * conversation/message/outreach_log rows and state transitions happen
   * exactly once per draft (idempotency key = draft id). State advances to
   * OUTREACH_SENT only AFTER delivery succeeds — if a guard blocks the send,
   * the job stays in its approval state for a later retry.
   */
  async sendDraft(draft: OutreachDraftRecord): Promise<SendResult> {
    const job = this.deps.jobs.requireById(draft.jobId);
    const lead = this.deps.leads.requireLead(job.leadId);
    if (!lead.contactEmail) throw new ValidationError('lead has no contact email');

    const idempotencyKey = `outreach:send:${draft.id}`;
    const alreadyLogged = this.deps.outreach.hasLog(idempotencyKey);
    if (!alreadyLogged) {
      const current = this.deps.jobs.requireById(draft.jobId);
      if (current.state !== 'AWAITING_OUTREACH_APPROVAL' && current.state !== 'READY_FOR_OUTREACH') {
        throw new ValidationError(`cannot send draft for job in state ${current.state}`);
      }
    }
    const result = await this.deliver({
      leadId: lead.id,
      jobId: draft.jobId,
      to: lead.contactEmail,
      subject: draft.subject,
      body: draft.bodyText,
      idempotencyKey,
      details: { draftId: draft.id },
      isReply: false,
    });

    if (result.sent && result.fresh) {
      const state = this.deps.jobs.requireById(draft.jobId).state;
      if (state === 'AWAITING_OUTREACH_APPROVAL' || state === 'READY_FOR_OUTREACH') {
        this.deps.engine.transition(draft.jobId, 'OUTREACH_SENT', {
          actor: 'system',
          actorType: 'system',
          reason: 'delivery confirmed',
        });
      }
      if (this.deps.jobs.requireById(draft.jobId).state === 'OUTREACH_SENT') {
        this.deps.engine.transition(draft.jobId, 'AWAITING_REPLY', SYSTEM);
      }
    }
    return result;
  }

  /**
   * Sends a reply inside an active conversation. Same guard stack; requires
   * that the lead was already contacted (replies are never cold contact).
   */
  async sendConversationReply(
    leadId: string,
    subject: string,
    body: string,
    inReplyToMessageId?: string,
  ): Promise<SendResult> {
    const job = this.deps.engine.getOrCreateJobForLead(leadId);
    const lead = this.deps.leads.requireLead(leadId);
    if (!lead.contactEmail) throw new ValidationError('lead has no contact email');
    if (!this.deps.outreach.hasSentToLead(leadId)) {
      throw new ExternalActionError('refusing to email a lead that was never contacted');
    }

    const verdict = this.guardContext(lead, this.now(), true);
    if (!verdict.allowed) {
      return this.block(verdict.guard, verdict.reason, job.id, leadId, { kind: 'conversation_reply' });
    }

    // M4-1: full-body hash + inbound message discriminator — distinct replies
    // can never collide on a truncated prefix.
    const bodyHash = createHash('sha256').update(body).digest('hex').slice(0, 32);
    return this.deliver({
      leadId,
      jobId: job.id,
      to: lead.contactEmail,
      subject,
      body,
      idempotencyKey: `outreach:reply:${leadId}:${inReplyToMessageId ?? 'cold'}:${bodyHash}`,
      details: { kind: 'conversation_reply', inReplyToMessageId },
      inReplyToMessageId,
      isReply: true,
    });
  }

  private block(guard: string, reason: string, jobId: string, leadId: string, extra: Record<string, unknown>): SendResult {
    this.deps.audit.append({
      actor: 'system',
      actorType: 'system',
      action: 'outreach.blocked',
      jobId,
      leadId,
      details: { guard, reason, ...extra },
    });
    this.deps.log.warn({ guard, reason, jobId }, 'outbound email blocked');
    return { sent: false, reason, fresh: false };
  }

  /** Exactly-once delivery via TRANSACTIONAL OUTBOX (no tx across network I/O). */
  private async deliver(args: {
    leadId: string;
    jobId: string;
    to: string;
    subject: string;
    body: string;
    idempotencyKey: string;
    details: Record<string, unknown>;
    inReplyToMessageId?: string;
    isReply: boolean;
  }): Promise<SendResult> {
    // Replay: if this action already completed, return the cached result.
    const claim = this.deps.idempotency.claim(args.idempotencyKey, 'outreach');
    if (!claim.fresh) {
      const cached = claim.result as { providerMessageId: string } | undefined;
      return cached?.providerMessageId
        ? { sent: true, providerMessageId: cached.providerMessageId, fresh: false }
        : { sent: true, providerMessageId: 'unknown', fresh: false };
    }

    try {
      // PHASE 1 (sync tx): guards + never-cold-contact refusal + outbox row.
      this.db.transaction(() => {
        const recheck = this.guardContext(this.deps.leads.requireLead(args.leadId), this.now(), args.isReply);
        if (!recheck.allowed) throw new SendBlockedError(recheck.guard, recheck.reason);
        if (args.isReply && !this.deps.outreach.hasSentToLead(args.leadId)) {
          // Concurrency-safe: inside the same tx as the outbox claim, so two
          // racing replies to a never-contacted lead cannot both pass.
          throw new SendBlockedError('never_contacted', 'refusing to email a lead that was never contacted');
        }
        this.deps.outreach.openLog({
          jobId: args.jobId,
          leadId: args.leadId,
          idempotencyKey: args.idempotencyKey,
          provider: this.deps.emailProvider.name,
        });
      });

      // PHASE 2: provider call with NO transaction open — other flows can
      // transact freely; a failure here cannot roll back unrelated writes.
      const sent = await this.deps.emailProvider.send({
        to: args.to,
        subject: args.subject,
        body: args.body,
        leadId: args.leadId,
        jobId: args.jobId,
        idempotencyKey: args.idempotencyKey,
        inReplyToMessageId: args.inReplyToMessageId,
      });

      // PHASE 3 (sync tx): message + completed log + audit + key completion.
      this.db.transaction(() => {
        const conversation =
          this.deps.conversations.tryGetByLeadAndChannel(args.leadId, 'email') ??
          this.deps.conversations.createForLead(args.leadId, 'email', args.to, args.subject);
        const added = this.deps.conversations.addMessage({
          conversationId: conversation.id,
          direction: 'outbound',
          sender: SENDER_IDENTITY,
          subject: args.subject,
          bodyText: args.body,
          externalId: sent.providerMessageId,
          provider: this.deps.emailProvider.name,
        });
        this.deps.outreach.completeLog(args.idempotencyKey, sent.providerMessageId, added.message?.id ?? '');
        this.deps.idempotency.complete(args.idempotencyKey, { providerMessageId: sent.providerMessageId });
        this.deps.audit.append({
          actor: 'system',
          actorType: 'system',
          action: 'outreach.sent',
          jobId: args.jobId,
          leadId: args.leadId,
          details: { provider: this.deps.emailProvider.name, providerMessageId: sent.providerMessageId, ...args.details },
        });
      });
      return { sent: true, providerMessageId: sent.providerMessageId, fresh: true };
    } catch (err) {
      // Release the key so a later retry is possible; mark the outbox row.
      this.deps.outreach.failLog(args.idempotencyKey, err instanceof Error ? err.message : String(err));
      this.deps.idempotency.release(args.idempotencyKey);
      if (err instanceof SendBlockedError) {
        return { ...this.block(err.guard, err.reason, args.jobId, args.leadId, args.details), fresh: false };
      }
      throw err;
    }
  }
}
