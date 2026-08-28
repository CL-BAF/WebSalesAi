import { newId, nowIso } from '../../domain/ids.js';
import type { AgentRole } from '../../agents/types.js';
import type { Database } from '../database.js';

export interface AgentRunRecord {
  id: string;
  role: AgentRole;
  model: string;
  jobId: string | null;
  purpose: string;
  attempt: number;
  status: 'running' | 'succeeded' | 'failed' | 'rejected';
  inputJson: string | null;
  outputJson: string | null;
  usageJson: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface StartAgentRunInput {
  role: AgentRole;
  model: string;
  purpose: string;
  jobId?: string;
  inputJson?: string;
}

function rowToRun(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: String(row['id']),
    role: row['role'] as AgentRole,
    model: String(row['model']),
    jobId: (row['job_id'] as string | null) ?? null,
    purpose: String(row['purpose']),
    attempt: Number(row['attempt']),
    status: row['status'] as AgentRunRecord['status'],
    inputJson: (row['input_json'] as string | null) ?? null,
    outputJson: (row['output_json'] as string | null) ?? null,
    usageJson: (row['usage_json'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    startedAt: String(row['started_at']),
    finishedAt: (row['finished_at'] as string | null) ?? null,
  };
}

export class AgentRunRepository {
  constructor(private readonly db: Database) {}

  start(input: StartAgentRunInput): AgentRunRecord {
    const id = newId('run');
    const at = nowIso();
    this.db.run(
      `INSERT INTO agent_runs (id, role, model, job_id, purpose, attempt, status, input_json, started_at)
       VALUES (?, ?, ?, ?, ?, 1, 'running', ?, ?)`,
      id,
      input.role,
      input.model,
      input.jobId ?? null,
      input.purpose,
      input.inputJson ?? null,
      at,
    );
    return this.requireById(id);
  }

  finish(
    id: string,
    result: { status: 'succeeded' | 'failed' | 'rejected'; outputJson?: string; usageJson?: string; error?: string },
  ): void {
    this.db.run(
      `UPDATE agent_runs
       SET status = ?, output_json = COALESCE(?, output_json), usage_json = COALESCE(?, usage_json), error = COALESCE(?, error), finished_at = ?
       WHERE id = ?`,
      result.status,
      result.outputJson ?? null,
      result.usageJson ?? null,
      result.error ?? null,
      nowIso(),
      id,
    );
  }

  requireById(id: string): AgentRunRecord {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM agent_runs WHERE id = ?', id);
    if (!row) throw new Error(`agent run not found: ${id}`);
    return rowToRun(row);
  }

  listByJob(jobId: string, limit = 200): AgentRunRecord[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM agent_runs WHERE job_id = ? ORDER BY started_at ASC LIMIT ?',
        jobId,
        limit,
      )
      .map(rowToRun);
  }

  countRunningByPurpose(purpose: string): number {
    const row = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM agent_runs WHERE purpose = ? AND status = 'running'",
      purpose,
    );
    return Number(row?.c ?? 0);
  }
}
