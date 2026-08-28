import { nowIso } from '../domain/ids.js';
import { ConflictError, InvalidTransitionError, NotFoundError } from '../domain/errors.js';
import {
  assertTransition,
  TERMINAL_STATES,
  type ActorType,
  type WorkflowState,
} from '../domain/workflow.js';
import type { AuditEventRepository, AuditAction } from '../db/repositories/auditEvents.js';
import type { WorkflowJobRepository, WorkflowJobRecord } from '../db/repositories/workflowJobs.js';
import type { Database } from '../db/database.js';

export interface TransitionContext {
  actor: string;
  actorType: ActorType;
  reason?: string;
}

export interface TransitionResult {
  job: WorkflowJobRecord;
  from: WorkflowState;
  to: WorkflowState;
}

/**
 * Deterministic workflow controller. All state changes:
 *  - are validated against the explicit transition table,
 *  - run inside a BEGIN IMMEDIATE transaction with a WHERE-guarded UPDATE
 *    (two racing transitions cannot both succeed; the loser gets ConflictError),
 *  - are recorded as durable audit events.
 */
export class WorkflowEngine {
  constructor(
    private readonly db: Database,
    private readonly jobs: WorkflowJobRepository,
    private readonly audit: AuditEventRepository,
  ) {}

  getOrCreateJobForLead(leadId: string, actor: string = 'system'): WorkflowJobRecord {
    const existing = this.jobs.tryGetByLeadId(leadId);
    if (existing) return existing;
    const job = this.db.transaction(() => {
      const created = this.jobs.createForLead(leadId, 'LEAD_DISCOVERED');
      this.audit.append({
        actor,
        actorType: 'system',
        action: 'job.created',
        jobId: created.id,
        leadId,
        details: { initialState: created.state },
      });
      return created;
    });
    return job;
  }

  transition(jobId: string, to: WorkflowState, ctx: TransitionContext): TransitionResult {
    let fromState: WorkflowState | undefined;
    try {
      return this.db.transaction(() => {
        const job = this.jobs.tryGetById(jobId);
        if (!job) throw new NotFoundError('workflow job', jobId);
        fromState = job.state;
        assertTransition(fromState, to);

        const at = nowIso();
        const changed = this.jobs.guardedTransition(jobId, fromState, to, at);
        if (!changed) {
          // Another writer moved the job between our read and our update.
          throw new ConflictError(`job ${jobId} changed state concurrently (expected ${fromState})`);
        }

        if (to === 'FAILED') {
          this.jobs.setFailureReason(jobId, ctx.reason ?? 'unspecified failure');
        }

        this.audit.append({
          actor: ctx.actor,
          actorType: ctx.actorType,
          action: 'state.transition',
          jobId,
          leadId: job.leadId,
          details: { from: fromState, to, reason: ctx.reason },
        });

        const updated = this.jobs.requireById(jobId);
        return { job: updated, from: fromState, to };
      });
    } catch (err) {
      // Rejection evidence must survive the rolled-back transaction, so it is
      // appended AFTER the rollback, outside it.
      if (err instanceof InvalidTransitionError || err instanceof ConflictError) {
        const leadId = this.jobs.tryGetById(jobId)?.leadId;
        this.audit.append({
          actor: ctx.actor,
          actorType: ctx.actorType,
          action: 'state.transition_rejected',
          jobId,
          leadId,
          details: { from: fromState, to, reason: ctx.reason, error: err.message },
        });
      }
      throw err;
    }
  }

  transitionLead(leadId: string, to: WorkflowState, ctx: TransitionContext): TransitionResult {
    const job = this.jobs.tryGetByLeadId(leadId);
    if (!job) throw new NotFoundError('workflow job for lead', leadId);
    return this.transition(job.id, to, ctx);
  }

  isTerminal(jobId: string): boolean {
    const job = this.jobs.tryGetById(jobId);
    if (!job) throw new NotFoundError('workflow job', jobId);
    return TERMINAL_STATES.has(job.state);
  }

  auditAction(action: AuditAction | string, ctx: TransitionContext & { jobId?: string; leadId?: string; details?: Record<string, unknown> }): void {
    this.audit.append({
      actor: ctx.actor,
      actorType: ctx.actorType,
      action,
      jobId: ctx.jobId,
      leadId: ctx.leadId,
      details: ctx.details,
    });
  }
}
