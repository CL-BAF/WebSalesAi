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
  status: 'sending' | 'sent' | 'failed';
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
    status: (row['status'] as OutreachLogRecord['status']) ?? 'sent',
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

  /**
   * L4-3: atomic decide — the UPDATE is guarded by status='pending', so a
   * second approver gets a clear "already decided" error instead of
   * spuriously double-auditing.
   */
  decideDraft(id: string, status: 'approved' | 'rejected', decidedBy: string): OutreachDraftRecord {
    const res = this.db.run(
      "UPDATE outreach_drafts SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      status,
      decidedBy,
      nowIso(),
      nowIso(),
      id,
    );
    if (Number(res.changes) === 0) {
      const current = this.requireDraft(id);
      throw new Error(`draft ${id} already decided (status: ${current.status})`);
    }
    return this.requireDraft(id);
  }

  /**
   * Transactional-outbox insert: claims the log row with status 'sending'.
   * Safe to call on retry after a crash — INSERT OR IGNORE + re-read by key.
   */
  openLog(input: {
    jobId: string;
    leadId: string;
    idempotencyKey: string;
    provider: string;
    conversationId?: string;
  }): OutreachLogRecord {
    const at = nowIso();
    this.db.run(
      `INSERT OR IGNORE INTO outreach_log (id, job_id, lead_id, conversation_id, idempotency_key, provider, status, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
      newId('orl'),
      input.jobId,
      input.leadId,
      input.conversationId ?? null,
      input.idempotencyKey,
      input.provider,
      at,
      at,
    );
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM outreach_log WHERE idempotency_key = ?', input.idempotencyKey);
    if (!row) throw new Error('failed to open outreach log row');
    return rowToLog(row);
  }

  /** Completes the outbox row: status 'sent' + provider/message linkage. */
  completeLog(idempotencyKey: string, providerMessageId: string, messageId: string): void {
    this.db.run(
      "UPDATE outreach_log SET status = 'sent', provider_message_id = ?, message_id = ? WHERE idempotency_key = ?",
      providerMessageId,
      messageId,
      idempotencyKey,
    );
  }

  /** Marks the outbox row failed after a provider error (retryable). */
  failLog(idempotencyKey: string, error: string): void {
    this.db.run(
      "UPDATE outreach_log SET status = 'failed' WHERE idempotency_key = ?",
      idempotencyKey,
    );
    void error;
  }

  tryGetLogByKey(idempotencyKey: string): OutreachLogRecord | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM outreach_log WHERE idempotency_key = ?', idempotencyKey);
    return row ? rowToLog(row) : undefined;
  }

  countSince(provider: string, sinceIso: string): number {
    const row = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM outreach_log WHERE provider = ? AND status != 'failed' AND sent_at >= ?",
      provider,
      sinceIso,
    );
    return Number(row?.c ?? 0);
  }

  countForDomainSince(domain: string, sinceIso: string): number {
    // Recipient email lives on the lead; count sends to leads whose
    // contact_email ends with @domain. Failed attempts do not count.
    const like = `%@${domain}`;
    const row = this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM outreach_log o
       JOIN leads l ON l.id = o.lead_id
       WHERE o.status != 'failed' AND o.sent_at >= ? AND LOWER(l.contact_email) LIKE ?`,
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
       WHERE o.status != 'failed' AND LOWER(l.contact_email) = LOWER(?)`,
      email,
    );
    return row?.sent_at;
  }

  hasSentToLead(leadId: string): boolean {
    const row = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM outreach_log WHERE lead_id = ? AND status != 'failed'",
      leadId,
    );
    return Number(row?.c ?? 0) > 0;
  }

  hasLog(idempotencyKey: string): boolean {
    const row = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM outreach_log WHERE idempotency_key = ?', idempotencyKey);
    return Number(row?.c ?? 0) > 0;
  }
}
