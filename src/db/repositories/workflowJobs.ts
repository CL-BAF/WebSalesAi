import { newId, nowIso } from '../../domain/ids.js';
import type { WorkflowState } from '../../domain/workflow.js';
import type { Database } from '../database.js';

export interface WorkflowJobRecord {
  id: string;
  leadId: string;
  state: WorkflowState;
  stateEnteredAt: string;
  revisionCycles: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToJob(row: Record<string, unknown>): WorkflowJobRecord {
  return {
    id: String(row['id']),
    leadId: String(row['lead_id']),
    state: row['state'] as WorkflowState,
    stateEnteredAt: String(row['state_entered_at']),
    revisionCycles: Number(row['revision_cycles']),
    failureReason: (row['failure_reason'] as string | null) ?? null,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export class WorkflowJobRepository {
  constructor(private readonly db: Database) {}

  createForLead(leadId: string, initialState: WorkflowState): WorkflowJobRecord {
    const id = newId('job');
    const at = nowIso();
    this.db.run(
      `INSERT INTO workflow_jobs (id, lead_id, state, state_entered_at, revision_cycles, failure_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`,
      id,
      leadId,
      initialState,
      at,
      at,
      at,
    );
    return this.requireById(id);
  }

  requireById(id: string): WorkflowJobRecord {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM workflow_jobs WHERE id = ?', id);
    if (!row) throw new Error(`workflow job not found: ${id}`);
    return rowToJob(row);
  }

  tryGetById(id: string): WorkflowJobRecord | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM workflow_jobs WHERE id = ?', id);
    return row ? rowToJob(row) : undefined;
  }

  tryGetByLeadId(leadId: string): WorkflowJobRecord | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM workflow_jobs WHERE lead_id = ?', leadId);
    return row ? rowToJob(row) : undefined;
  }

  requireByLeadId(leadId: string): WorkflowJobRecord {
    const job = this.tryGetByLeadId(leadId);
    if (!job) throw new Error(`workflow job not found for lead: ${leadId}`);
    return job;
  }

  listByStates(states: WorkflowState[], limit = 500): WorkflowJobRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    return this.db
      .all<Record<string, unknown>>(
        `SELECT * FROM workflow_jobs WHERE state IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`,
        ...states,
        limit,
      )
      .map(rowToJob);
  }

  listAll(limit = 1000): WorkflowJobRecord[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM workflow_jobs ORDER BY updated_at DESC LIMIT ?', limit)
      .map(rowToJob);
  }

  /**
   * Optimistic concurrency transition: the UPDATE is guarded by the current
   * state, so exactly one of two racing transitions can succeed.
   * Returns the number of rows changed (0 means the guard lost the race).
   */
  guardedTransition(
    jobId: string,
    expectedState: WorkflowState,
    nextState: WorkflowState,
    at: string,
  ): boolean {
    const res = this.db.run(
      `UPDATE workflow_jobs
       SET state = ?, state_entered_at = ?, updated_at = ?
       WHERE id = ? AND state = ?`,
      nextState,
      at,
      at,
      jobId,
      expectedState,
    );
    return Number(res.changes) === 1;
  }

  incrementRevisionCycles(jobId: string): number {
    const row = this.db.get<{ revision_cycles: number }>(
      'UPDATE workflow_jobs SET revision_cycles = revision_cycles + 1, updated_at = ? WHERE id = ? RETURNING revision_cycles',
      nowIso(),
      jobId,
    );
    return Number(row?.revision_cycles ?? 0);
  }

  getRevisionCycles(jobId: string): number {
    const row = this.db.get<{ revision_cycles: number }>('SELECT revision_cycles FROM workflow_jobs WHERE id = ?', jobId);
    return Number(row?.revision_cycles ?? 0);
  }

  setFailureReason(jobId: string, reason: string | null): void {
    this.db.run('UPDATE workflow_jobs SET failure_reason = ?, updated_at = ? WHERE id = ?', reason, nowIso(), jobId);
  }
}
