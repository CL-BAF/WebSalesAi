import { newId, nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

export interface WebsiteProjectRecord {
  id: string;
  jobId: string;
  workspacePath: string;
  status: 'draft' | 'generated' | 'in_review' | 'revision_required' | 'approved' | 'deployed_preview' | 'deployed_production';
  createdAt: string;
  updatedAt: string;
}

function rowToProject(row: Record<string, unknown>): WebsiteProjectRecord {
  return {
    id: String(row['id']),
    jobId: String(row['job_id']),
    workspacePath: String(row['workspace_path']),
    status: row['status'] as WebsiteProjectRecord['status'],
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export class WebsiteProjectRepository {
  constructor(private readonly db: Database) {}

  /** One project per job (UNIQUE job_id); creates or returns existing. */
  upsertForJob(jobId: string, workspacePath: string, status: WebsiteProjectRecord['status']): WebsiteProjectRecord {
    const at = nowIso();
    this.db.run(
      `INSERT INTO website_projects (id, job_id, workspace_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
      newId('prj'),
      jobId,
      workspacePath,
      status,
      at,
      at,
    );
    return this.requireByJobId(jobId);
  }

  setStatus(jobId: string, status: WebsiteProjectRecord['status']): void {
    this.db.run('UPDATE website_projects SET status = ?, updated_at = ? WHERE job_id = ?', status, nowIso(), jobId);
  }

  tryGetByJobId(jobId: string): WebsiteProjectRecord | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM website_projects WHERE job_id = ?', jobId);
    return row ? rowToProject(row) : undefined;
  }

  requireByJobId(jobId: string): WebsiteProjectRecord {
    const project = this.tryGetByJobId(jobId);
    if (!project) throw new Error(`website project not found for job: ${jobId}`);
    return project;
  }
}
