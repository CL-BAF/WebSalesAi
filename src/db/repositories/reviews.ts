import { newId, nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

export interface ReviewRecord {
  id: string;
  jobId: string;
  projectId: string;
  cycle: number;
  verdict: 'PASS' | 'CHANGES_REQUIRED';
  findingsJson: string | null;
  reviewerRunId: string | null;
  artifactCommit: string | null;
  artifactHash: string | null;
  createdAt: string;
}

function rowToReview(row: Record<string, unknown>): ReviewRecord {
  return {
    id: String(row['id']),
    jobId: String(row['job_id']),
    projectId: String(row['project_id']),
    cycle: Number(row['cycle']),
    verdict: row['verdict'] as ReviewRecord['verdict'],
    findingsJson: (row['findings_json'] as string | null) ?? null,
    reviewerRunId: (row['reviewer_run_id'] as string | null) ?? null,
    artifactCommit: (row['artifact_commit'] as string | null) ?? null,
    artifactHash: (row['artifact_hash'] as string | null) ?? null,
    createdAt: String(row['created_at']),
  };
}

export class ReviewRepository {
  constructor(private readonly db: Database) {}

  nextCycle(jobId: string): number {
    const row = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM reviews WHERE job_id = ?', jobId);
    return Number(row?.c ?? 0) + 1;
  }

  record(input: {
    jobId: string;
    projectId: string;
    cycle: number;
    verdict: 'PASS' | 'CHANGES_REQUIRED';
    findings: unknown;
    reviewerRunId?: string | null;
    artifactCommit?: string | null;
    artifactHash?: string | null;
  }): ReviewRecord {
    const id = newId('rev');
    const at = nowIso();
    this.db.run(
      `INSERT INTO reviews (id, job_id, project_id, cycle, verdict, findings_json, reviewer_run_id, artifact_commit, artifact_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.jobId,
      input.projectId,
      input.cycle,
      input.verdict,
      JSON.stringify(input.findings ?? null),
      input.reviewerRunId ?? null,
      input.artifactCommit ?? null,
      input.artifactHash ?? null,
      at,
    );
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM reviews WHERE id = ?', id);
    return rowToReview(row!);
  }

  listByJob(jobId: string): ReviewRecord[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM reviews WHERE job_id = ? ORDER BY cycle ASC', jobId)
      .map(rowToReview);
  }
}
