import { newId, nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

export interface DeploymentRecord {
  id: string;
  jobId: string;
  projectId: string;
  kind: 'preview' | 'production';
  provider: string;
  status: 'deploying' | 'deployed' | 'failed';
  url: string | null;
  commitHash: string | null;
  idempotencyKey: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToDeployment(row: Record<string, unknown>): DeploymentRecord {
  return {
    id: String(row['id']),
    jobId: String(row['job_id']),
    projectId: String(row['project_id']),
    kind: row['kind'] as DeploymentRecord['kind'],
    provider: String(row['provider']),
    status: row['status'] as DeploymentRecord['status'],
    url: (row['url'] as string | null) ?? null,
    commitHash: (row['commit_hash'] as string | null) ?? null,
    idempotencyKey: String(row['idempotency_key']),
    error: (row['error'] as string | null) ?? null,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export class DeploymentRepository {
  constructor(private readonly db: Database) {}

  /** Outbox-style claim: INSERT OR IGNORE on the UNIQUE idempotency key. */
  open(input: { jobId: string; projectId: string; kind: 'preview' | 'production'; provider: string; idempotencyKey: string; commitHash?: string }): { fresh: boolean; record: DeploymentRecord } {
    const at = nowIso();
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO deployments (id, job_id, project_id, kind, provider, status, commit_hash, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'deploying', ?, ?, ?, ?)`,
      newId('dep'),
      input.jobId,
      input.projectId,
      input.kind,
      input.provider,
      input.commitHash ?? null,
      input.idempotencyKey,
      at,
      at,
    );
    const record = this.requireByIdempotencyKey(input.idempotencyKey);
    return { fresh: Number(inserted.changes) === 1, record };
  }

  complete(idempotencyKey: string, url: string, providerReference?: string): void {
    this.db.run(
      "UPDATE deployments SET status = 'deployed', url = ?, error = NULL, updated_at = ? WHERE idempotency_key = ?",
      url,
      nowIso(),
      idempotencyKey,
    );
    void providerReference;
  }

  fail(idempotencyKey: string, error: string): void {
    this.db.run(
      "UPDATE deployments SET status = 'failed', error = ?, updated_at = ? WHERE idempotency_key = ?",
      error.slice(0, 500),
      nowIso(),
      idempotencyKey,
    );
  }

  requireByIdempotencyKey(idempotencyKey: string): DeploymentRecord {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM deployments WHERE idempotency_key = ?', idempotencyKey);
    if (!row) throw new Error(`deployment not found: ${idempotencyKey}`);
    return rowToDeployment(row);
  }

  listByJob(jobId: string): DeploymentRecord[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM deployments WHERE job_id = ? ORDER BY created_at ASC', jobId)
      .map(rowToDeployment);
  }
}
