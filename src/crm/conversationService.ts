import { type SalesAgent } from './salesAgent.js';
import type { ReplyClassification } from '../agents/schemas.js';
import type { LeadRepository } from '../db/repositories/leads.js';
import type { ConversationRepository, MessageRecord } from '../db/repositories/conversations.js';
import type { SuppressionRepository } from '../db/repositories/suppressions.js';
import type { RequirementRepository } from '../db/repositories/requirements.js';
import type { WorkflowEngine } from '../engine/workflowEngine.js';
import type { AuditEventRepository } from '../db/repositories/auditEvents.js';
import type { WorkflowJobRecord } from '../db/repositories/workflowJobs.js';
import type { OutreachService } from '../outreach/outreachService.js';
import type { Logger } from '../logger.js';
import { TERMINAL_STATES, type WorkflowState } from '../domain/workflow.js';

export interface InboundReplyInput {
  fromEmail: string;
  subject?: string;
  body: string;
  externalId?: string;
  provider?: string;
}

export type ReplyOutcome =
  | { outcome: 'unknown_sender' }
  | { outcome: 'duplicate' }
  | { outcome: 'failed'; leadId: string; jobId: string; error: string }
  | {
      outcome: 'processed';
      leadId: string;
      jobId: string;
      intent: ReplyClassification['intent'];
      via: 'deterministic' | 'agent';
      transitionsApplied: WorkflowState[];
      requirementsAdded: number;
      autoReplySent: boolean;
      flaggedForHumanReview: boolean;
      optOut: boolean;
    };

export interface ConversationServiceDeps {
  leads: LeadRepository;
  conversations: ConversationRepository;
  suppressions: SuppressionRepository;
  requirements: RequirementRepository;
  engine: WorkflowEngine;
  audit: AuditEventRepository;
  salesAgent: SalesAgent;
  outreach: OutreachService;
  log: Logger;
}

const SYSTEM = { actor: 'system', actorType: 'system' as const };

/**
 * Inbound reply pipeline. Deterministic application code decides every state
 * change; the Sales agent only classifies. Opt-out detection is deterministic
 * FIRST (never delegated to the model), and opt-outs are enforced at every
 * later guard.
 */
export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  async recordInboundReply(input: InboundReplyInput): Promise<ReplyOutcome> {
    const lead = this.deps.leads.tryGetByEmail(input.fromEmail);
    if (!lead) {
      this.deps.audit.append({
        actor: 'provider',
        actorType: 'provider',
        action: 'webhook.rejected',
        details: { reason: 'no lead for sender', from: input.fromEmail, provider: input.provider ?? 'unknown' },
      });
      return { outcome: 'unknown_sender' };
    }
    const job = this.deps.engine.getOrCreateJobForLead(lead.id);

    const conversation =
      this.deps.conversations.tryGetByLeadAndChannel(lead.id, 'email') ??
      this.deps.conversations.createForLead(lead.id, 'email', input.fromEmail, input.subject);

    const added = this.deps.conversations.addMessage({
      conversationId: conversation.id,
      direction: 'inbound',
      sender: input.fromEmail,
      subject: input.subject,
      bodyText: input.body,
      externalId: input.externalId,
      provider: input.provider,
    });

    // M4-2: a webhook replay of an UNPROCESSED message re-enters the
    // pipeline instead of being short-circuited — a transient classification
    // failure must never permanently orphan a customer reply.
    let message: MessageRecord;
    if (added.duplicate) {
      if (!input.externalId) return { outcome: 'duplicate' };
      const existing = this.deps.conversations.tryGetByExternalId(conversation.id, input.externalId);
      if (!existing || existing.direction !== 'inbound') return { outcome: 'duplicate' };
      if (this.deps.conversations.isProcessed(existing.id)) return { outcome: 'duplicate' };
      message = existing;
      this.deps.audit.append({
        actor: 'provider',
        actorType: 'provider',
        action: 'webhook.received',
        leadId: lead.id,
        jobId: job.id,
        details: { messageId: message.id, note: 'unprocessed replay; re-entering pipeline' },
      });
    } else {
      message = added.message as MessageRecord;
      this.deps.audit.append({
        actor: 'provider',
        actorType: 'provider',
        action: 'reply.received',
        leadId: lead.id,
        jobId: job.id,
        details: { messageId: message.id, from: input.fromEmail, subject: input.subject ?? null, provider: input.provider ?? 'unknown' },
      });
    }

    // 1) Classify. SalesAgent runs deterministic opt-out detection FIRST and
    // records the decision (agent_runs + audit) before any model call.
    const history = this.deps.conversations.listMessages(conversation.id).map((m) => ({
      direction: m.direction,
      body: m.bodyText,
      sentAt: m.createdAt,
    }));
    let classified: Awaited<ReturnType<SalesAgent['classifyReply']>>;
    try {
      classified = await this.deps.salesAgent.classifyReply({
        jobId: job.id,
        businessName: this.deps.leads.requireBusiness(lead.businessId).name,
        conversationHistory: history,
        latestMessage: input.body,
      });
    } catch (err) {
      // Message stays unprocessed; a webhook retry will re-enter the pipeline.
      const error = err instanceof Error ? err.message : String(err);
      this.deps.audit.append({
        actor: 'system',
        actorType: 'system',
        action: 'error.occurred',
        leadId: lead.id,
        jobId: job.id,
        details: { stage: 'reply_classification', messageId: message.id, error },
      });
      return { outcome: 'failed', leadId: lead.id, jobId: job.id, error };
    }
    const classification = classified.classification;
    const via: 'deterministic' | 'agent' =
      classified.model === 'deterministic-optout-detector' ? 'deterministic' : 'agent';

    // 2) Enforce opt-out: suppress email AND domain, transition, close thread.
    if (classification.intent === 'opt_out') {
      const outcome = this.applyOptOut(job, lead, input, message, via, classification);
      this.deps.conversations.markProcessed(message.id);
      return outcome;
    }

    // 3) Persist extracted requirements (only what the customer actually said).
    for (const req of classification.extractedRequirements) {
      this.deps.requirements.add({
        jobId: job.id,
        category: req.category,
        title: req.title,
        detail: req.detail,
        source: 'customer_reply',
        sourceMessageId: message.id,
      });
    }
    const requirementsAdded = classification.extractedRequirements.length;
    if (requirementsAdded > 0) {
      this.deps.audit.append({
        actor: 'agent:sales',
        actorType: 'agent',
        action: 'requirements.updated',
        jobId: job.id,
        leadId: lead.id,
        details: { added: requirementsAdded, sourceMessageId: message.id },
      });
    }

    // 4) Plan deterministic follow-up actions from the CURRENT state.
    const plan = this.planReplyActions(job, classification, requirementsAdded > 0);

    // 5) Auto-reply (question/ambiguous/positive) through the same guard stack.
    let autoReplySent = false;
    if (plan.sendReply && classification.suggestedReply) {
      const send = await this.deps.outreach.sendConversationReply(
        lead.id,
        input.subject ? (input.subject.startsWith('Re:') ? input.subject : `Re: ${input.subject}`) : 'Re: your enquiry',
        classification.suggestedReply,
        message.externalId ?? message.id,
      );
      autoReplySent = send.sent;
    }

    // 6) Apply transitions in order.
    const applied: WorkflowState[] = [];
    for (const target of plan.transitions) {
      try {
        this.deps.engine.transition(job.id, target, {
          actor: 'system',
          actorType: 'system',
          reason: `reply processed (intent=${classification.intent}, via=${via})`,
        });
        applied.push(target);
      } catch (err) {
        this.deps.audit.append({
          actor: 'system',
          actorType: 'system',
          action: 'error.occurred',
          jobId: job.id,
          leadId: lead.id,
          details: { stage: 'reply_pipeline_transition', target, error: err instanceof Error ? err.message : String(err) },
        });
        break;
      }
    }

    if (plan.flagHumanReview && !plan.transitions.includes('NEEDS_HUMAN_REVIEW')) {
      this.deps.audit.append({
        actor: 'system',
        actorType: 'system',
        action: 'human_review.requested',
        jobId: job.id,
        leadId: lead.id,
        details: { reason: classification.summary.slice(0, 200) },
      });
    }

    // Pipeline complete: mark the message processed (a webhook replay is now
    // a genuine duplicate rather than a re-entry).
    this.deps.conversations.markProcessed(message.id);

    this.deps.audit.append({
      actor: 'agent:sales',
      actorType: 'agent',
      action: 'reply.processed',
      jobId: job.id,
      leadId: lead.id,
      details: {
        intent: classification.intent,
        via,
        confidence: classification.confidence,
        transitions: applied,
        autoReplySent,
        requirementsAdded,
      },
    });

    return {
      outcome: 'processed',
      leadId: lead.id,
      jobId: job.id,
      intent: classification.intent,
      via,
      transitionsApplied: applied,
      requirementsAdded,
      autoReplySent,
      flaggedForHumanReview: plan.flagHumanReview,
      optOut: false,
    };
  }

  private applyOptOut(
    job: WorkflowJobRecord,
    lead: { id: string; contactEmail: string | null; websiteUrl: string | null },
    input: InboundReplyInput,
    message: MessageRecord,
    via: 'deterministic' | 'agent',
    classification: ReplyClassification,
  ): ReplyOutcome {
    // L4-2 trade-off (documented): DETERMINISTIC opt-out evidence suppresses
    // email AND domain (high confidence, inject-resistant). An AGENT-detected
    // opt-out suppresses only the email — a domain-wide block is sticky and
    // could be triggered by injection in reply content, so domain suppression
    // on agent classification is flagged for owner confirmation instead.
    if (lead.contactEmail) {
      this.deps.suppressions.add(lead.contactEmail, 'email', 'customer opt-out', 'inbound-email');
    }
    const domain = lead.websiteUrl ? this.hostOf(lead.websiteUrl) : (lead.contactEmail?.split('@')[1] ?? null);
    if (domain && via === 'deterministic') {
      this.deps.suppressions.add(domain, 'domain', 'customer opt-out', 'inbound-email');
    }
    this.deps.audit.append({
      actor: 'provider',
      actorType: 'provider',
      action: 'optout.recorded',
      leadId: lead.id,
      jobId: job.id,
      details: { messageId: message.id, via, domainSuppressed: domain !== null && via === 'deterministic', evidence: input.body.slice(0, 200) },
    });
    if (domain && via !== 'deterministic') {
      this.deps.audit.append({
        actor: 'system',
        actorType: 'system',
        action: 'human_review.requested',
        leadId: lead.id,
        jobId: job.id,
        details: { reason: 'confirm domain-level suppression after agent-detected opt-out', domain },
      });
    }

    const transitionsApplied: WorkflowState[] = [];
    if (!TERMINAL_STATES.has(job.state)) {
      try {
        this.deps.engine.transition(job.id, 'OPTED_OUT', {
          actor: 'system',
          actorType: 'system',
          reason: 'customer opt-out',
        });
        transitionsApplied.push('OPTED_OUT');
      } catch (err) {
        this.deps.audit.append({
          actor: 'system',
          actorType: 'system',
          action: 'error.occurred',
          leadId: lead.id,
          jobId: job.id,
          details: { stage: 'optout_transition', error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    this.deps.audit.append({
      actor: 'agent:sales',
      actorType: 'agent',
      action: 'reply.processed',
      jobId: job.id,
      leadId: lead.id,
      details: { intent: 'opt_out', via, transitions: transitionsApplied, requirementsAdded: 0, autoReplySent: false },
    });
    return {
      outcome: 'processed',
      leadId: lead.id,
      jobId: job.id,
      intent: 'opt_out',
      via,
      transitionsApplied,
      requirementsAdded: 0,
      autoReplySent: false,
      flaggedForHumanReview: false,
      optOut: true,
    };
  }

  private planReplyActions(
    job: WorkflowJobRecord,
    classification: ReplyClassification,
    hasRequirements: boolean,
  ): { transitions: WorkflowState[]; sendReply: boolean; flagHumanReview: boolean } {
    if (TERMINAL_STATES.has(job.state)) {
      return { transitions: [], sendReply: false, flagHumanReview: false };
    }
    if (classification.needsHumanReview) {
      return { transitions: ['NEEDS_HUMAN_REVIEW'], sendReply: false, flagHumanReview: true };
    }

    const buildPhaseStates: WorkflowState[] = ['READY_TO_BUILD', 'BUILDING', 'REVIEWING', 'REVISION_REQUIRED', 'PREVIEW_READY', 'PREVIEW_SENT', 'AWAITING_PAYMENT', 'PAYMENT_CONFIRMED', 'READY_FOR_PRODUCTION', 'DEPLOYING', 'NEEDS_HUMAN_REVIEW', 'FAILED'];

    // Client approval of the preview is a customer-driven gate: an explicit
    // positive reply in AWAITING_CLIENT_APPROVAL advances to CLIENT_APPROVED.
    if (job.state === 'AWAITING_CLIENT_APPROVAL') {
      switch (classification.intent) {
        case 'positive':
          return { transitions: ['CLIENT_APPROVED'], sendReply: true, flagHumanReview: false };
        case 'negative':
          return { transitions: ['NEEDS_HUMAN_REVIEW'], sendReply: false, flagHumanReview: true };
        default:
          return { transitions: [], sendReply: false, flagHumanReview: true };
      }
    }

    // NOTE: intent 'opt_out' never reaches this planner — it returns early in
    // the pipeline (deterministic detector runs first; agent-detected opt-outs
    // are enforced identically in applyOptOut).
    switch (classification.intent) {
      case 'negative':
        return { transitions: ['NEEDS_HUMAN_REVIEW'], sendReply: false, flagHumanReview: true };
      case 'positive': {
        if (buildPhaseStates.includes(job.state)) {
          return { transitions: [], sendReply: false, flagHumanReview: true };
        }
        switch (job.state) {
          case 'AWAITING_REPLY':
            return { transitions: ['CONVERSATION_ACTIVE', hasRequirements ? 'REQUIREMENTS_PENDING' : 'INTERESTED'], sendReply: true, flagHumanReview: false };
          case 'CONVERSATION_ACTIVE':
            return { transitions: [hasRequirements ? 'REQUIREMENTS_PENDING' : 'INTERESTED'], sendReply: true, flagHumanReview: false };
          case 'INTERESTED':
            return { transitions: hasRequirements ? ['REQUIREMENTS_PENDING'] : [], sendReply: true, flagHumanReview: false };
          case 'REQUIREMENTS_PENDING':
            return { transitions: hasRequirements ? [] : ['CONVERSATION_ACTIVE'], sendReply: true, flagHumanReview: false };
          default:
            return { transitions: [], sendReply: false, flagHumanReview: true };
        }
      }
      case 'question':
      case 'ambiguous': {
        if (buildPhaseStates.includes(job.state)) {
          return { transitions: [], sendReply: false, flagHumanReview: true };
        }
        switch (job.state) {
          case 'AWAITING_REPLY':
            return { transitions: ['CONVERSATION_ACTIVE', 'AWAITING_REPLY'], sendReply: true, flagHumanReview: false };
          case 'CONVERSATION_ACTIVE':
            return { transitions: ['AWAITING_REPLY'], sendReply: true, flagHumanReview: false };
          case 'INTERESTED':
            return { transitions: [], sendReply: true, flagHumanReview: false };
          case 'REQUIREMENTS_PENDING':
            return { transitions: ['CONVERSATION_ACTIVE', 'AWAITING_REPLY'], sendReply: true, flagHumanReview: false };
          default:
            return { transitions: [], sendReply: false, flagHumanReview: true };
        }
      }
    }
    // Defensive unreachable: all intents are handled above.
    return { transitions: [], sendReply: false, flagHumanReview: true };
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    }
  }
}
