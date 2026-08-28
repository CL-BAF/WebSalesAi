import { newId, nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

export interface OutreachDraftRecord {
  id: string;
  jobId: string;
  subject: string;
  bodyText: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachLogRecord {
  id: string;
  jobId: string;
  leadId: string;
  conversationId: string | null;
  messageId: string | null;
  idempotencyKey: string;
  provider: string;
  providerMessageId: string | null;
  sentAt: string;
  createdAt: string;
}

function rowToDraft(row: Record<string, unknown>): OutreachDraftRecord {
  return {
    id: String(row['id']),
    jobId: String(row['job_id']),
    subject: String(row['subject']),
    bodyText: String(row['body_text']),
    status: row['status'] as OutreachDraftRecord['status'],
    decidedBy: (row['decided_by'] as string | null) ?? null,
    decidedAt: (row['decided_at'] as string | null) ?? null,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function rowToLog(row: Record<string, unknown>): OutreachLogRecord {
  return {
    id: String(row['id']),
    jobId: String(row['job_id']),
    leadId: String(row['lead_id']),
    conversationId: (row['conversation_id'] as string | null) ?? null,
    messageId: (row['message_id'] as string | null) ?? null,
    idempotencyKey: String(row['idempotency_key']),
    provider: String(row['provider']),
    providerMessageId: (row['provider_message_id'] as string | null) ?? null,
    sentAt: String(row['sent_at']),
    createdAt: String(row['created_at']),
  };
}

export class OutreachRepository {
  constructor(private readonly db: Database) {}

  createDraft(jobId: string, subject: string, bodyText: string): OutreachDraftRecord {
    const id = newId('draft');
    const at = nowIso();
    this.db.run(
      `INSERT INTO outreach_drafts (id, job_id, subject, body_text, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      jobId,
      subject,
      bodyText,
      at,
      at,
    );
    return this.requireDraft(id);
  }

  requireDraft(id: string): OutreachDraftRecord {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM outreach_drafts WHERE id = ?', id);
    if (!row) throw new Error(`outreach draft not found: ${id}`);
    return rowToDraft(row);
  }

  tryGetLatestDraftForJob(jobId: string): OutreachDraftRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM outreach_drafts WHERE job_id = ? ORDER BY created_at DESC LIMIT 1',
      jobId,
    );
    return row ? rowToDraft(row) : undefined;
  }

  decideDraft(id: string, status: 'approved' | 'rejected', decidedBy: string): OutreachDraftRecord {
    this.db.run(
      "UPDATE outreach_drafts SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      status,
      decidedBy,
      nowIso(),
      nowIso(),
      id,
    );
    return this.requireDraft(id);
  }

  addLog(input: {
    jobId: string;
    leadId: string;
    conversationId?: string;
    messageId?: string;
    idempotencyKey: string;
    provider: string;
    providerMessageId?: string;
  }): OutreachLogRecord {
    const id = newId('orl');
    const at = nowIso();
    this.db.run(
      `INSERT INTO outreach_log (id, job_id, lead_id, conversation_id, message_id, idempotency_key, provider, provider_message_id, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.jobId,
      input.leadId,
      input.conversationId ?? null,
      input.messageId ?? null,
      input.idempotencyKey,
      input.provider,
      input.providerMessageId ?? null,
      at,
      at,
    );
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM outreach_log WHERE id = ?', id);
    return rowToLog(row!);
  }

  countSince(provider: string, sinceIso: string): number {
    const row = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM outreach_log WHERE provider = ? AND sent_at >= ?',
      provider,
      sinceIso,
    );
    return Number(row?.c ?? 0);
  }

  countForDomainSince(domain: string, sinceIso: string): number {
    // recipient email stored in messages/conversations; outreach_log joins via
    // lead — count sends to leads whose contact_email ends with @domain.
    const like = `%@${domain}`;
    const row = this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM outreach_log o
       JOIN leads l ON l.id = o.lead_id
       WHERE o.sent_at >= ? AND LOWER(l.contact_email) LIKE ?`,
      sinceIso,
      like,
    );
    return Number(row?.c ?? 0);
  }

  lastSentToContact(email: string): string | undefined {
    const row = this.db.get<{ sent_at: string }>(
      `SELECT MAX(o.sent_at) AS sent_at
       FROM outreach_log o
       JOIN leads l ON l.id = o.lead_id
       WHERE LOWER(l.contact_email) = LOWER(?)`,
      email,
    );
    return row?.sent_at;
  }

  hasSentToLead(leadId: string): boolean {
    const row = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM outreach_log WHERE lead_id = ?', leadId);
    return Number(row?.c ?? 0) > 0;
  }

  hasLog(idempotencyKey: string): boolean {
    const row = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM outreach_log WHERE idempotency_key = ?', idempotencyKey);
    return Number(row?.c ?? 0) > 0;
  }
}
