import { newId, nowIso } from '../../domain/ids.js';
import { redactSecrets } from '../../logger.js';
import type { Database } from '../database.js';

export type AuditAction =
  | 'lead.imported'
  | 'lead.duplicate_skipped'
  | 'lead.suppressed'
  | 'job.created'
  | 'state.transition'
  | 'state.transition_rejected'
  | 'research.completed'
  | 'research.failed'
  | 'outreach.drafted'
  | 'outreach.approved'
  | 'outreach.rejected'
  | 'outreach.sent'
  | 'outreach.blocked'
  | 'reply.received'
  | 'reply.processed'
  | 'optout.recorded'
  | 'requirements.updated'
  | 'requirements.finalized'
  | 'generation.started'
  | 'generation.completed'
  | 'generation.failed'
  | 'files.generated'
  | 'command.executed'
  | 'review.completed'
  | 'review.failed'
  | 'preview.deployed'
  | 'preview.sent'
  | 'customer.approved'
  | 'customer.rejected'
  | 'payment.request_created'
  | 'payment.confirmed'
  | 'payment.failed'
  | 'production.deploy_requested'
  | 'production.deployed'
  | 'automation.paused'
  | 'automation.resumed'
  | 'kill_switch.changed'
  | 'agent.run_started'
  | 'agent.run_finished'
  | 'webhook.received'
  | 'webhook.rejected'
  | 'human_review.requested'
  | 'stage.retried'
  | 'error.occurred';

export interface AuditEventInput {
  actor: string;
  actorType: 'system' | 'agent' | 'owner' | 'provider';
  action: AuditAction | string;
  jobId?: string;
  leadId?: string;
  details?: Record<string, unknown>;
}

export interface AuditEventRecord {
  id: number;
  at: string;
  actor: string;
  actorType: string;
  action: string;
  jobId: string | null;
  leadId: string | null;
  details: Record<string, unknown> | null;
}

export class AuditEventRepository {
  constructor(private readonly db: Database) {}

  append(input: AuditEventInput): AuditEventRecord {
    const at = nowIso();
    const detailsJson = input.details === undefined ? null : JSON.stringify(redactSecrets(input.details));
    const res = this.db.run(
      `INSERT INTO audit_events (at, actor, actor_type, action, job_id, lead_id, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      at,
      input.actor,
      input.actorType,
      input.action,
      input.jobId ?? null,
      input.leadId ?? null,
      detailsJson,
    );
    return {
      id: Number(res.lastInsertRowid),
      at,
      actor: input.actor,
      actorType: input.actorType,
      action: input.action,
      jobId: input.jobId ?? null,
      leadId: input.leadId ?? null,
      details: input.details === undefined ? null : (JSON.parse(detailsJson as string) as Record<string, unknown>),
    };
  }

  listForJob(jobId: string, limit = 500): AuditEventRecord[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM audit_events WHERE job_id = ? ORDER BY id ASC LIMIT ?',
        jobId,
        limit,
      )
      .map(rowToEvent);
  }

  listForLead(leadId: string, limit = 500): AuditEventRecord[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM audit_events WHERE lead_id = ? OR job_id IN (SELECT id FROM workflow_jobs WHERE lead_id = ?) ORDER BY id ASC LIMIT ?',
        leadId,
        leadId,
        limit,
      )
      .map(rowToEvent);
  }

  listRecent(limit = 100): AuditEventRecord[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?', limit)
      .map(rowToEvent)
      .reverse();
  }
}

function rowToEvent(row: Record<string, unknown>): AuditEventRecord {
  return {
    id: Number(row['id']),
    at: String(row['at']),
    actor: String(row['actor']),
    actorType: String(row['actor_type']),
    action: String(row['action']),
    jobId: (row['job_id'] as string | null) ?? null,
    leadId: (row['lead_id'] as string | null) ?? null,
    details: row['details_json'] ? (JSON.parse(String(row['details_json'])) as Record<string, unknown>) : null,
  };
}

export { newId };
