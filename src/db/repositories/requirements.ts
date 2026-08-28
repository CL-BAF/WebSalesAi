import { newId, nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

export interface RequirementRecord {
  id: string;
  jobId: string;
  position: number;
  category: string;
  title: string;
  detail: string;
  source: string;
  sourceMessageId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function rowToRequirement(row: Record<string, unknown>): RequirementRecord {
  return {
    id: String(row['id']),
    jobId: String(row['job_id']),
    position: Number(row['position']),
    category: String(row['category']),
    title: String(row['title']),
    detail: String(row['detail']),
    source: String(row['source']),
    sourceMessageId: (row['source_message_id'] as string | null) ?? null,
    status: String(row['status']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export class RequirementRepository {
  constructor(private readonly db: Database) {}

  add(input: {
    jobId: string;
    category: string;
    title: string;
    detail: string;
    source: string;
    sourceMessageId?: string;
  }): RequirementRecord {
    const at = nowIso();
    const maxRow = this.db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM requirements WHERE job_id = ?', input.jobId);
    const position = Number(maxRow?.m ?? 0) + 1;
    const id = newId('req');
    this.db.run(
      `INSERT INTO requirements (id, job_id, position, category, title, detail, source, source_message_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      id,
      input.jobId,
      position,
      input.category,
      input.title,
      input.detail,
      input.source,
      input.sourceMessageId ?? null,
      at,
      at,
    );
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM requirements WHERE id = ?', id);
    return rowToRequirement(row!);
  }

  listByJob(jobId: string): RequirementRecord[] {
    return this.db
      .all<Record<string, unknown>>(
        "SELECT * FROM requirements WHERE job_id = ? AND status = 'active' ORDER BY position ASC",
        jobId,
      )
      .map(rowToRequirement);
  }

  deactivate(id: string): void {
    this.db.run("UPDATE requirements SET status = 'removed', updated_at = ? WHERE id = ?", nowIso(), id);
  }
}
