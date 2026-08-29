import { newId, nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

export interface ConversationRecord {
  id: string;
  leadId: string;
  channel: string;
  externalThreadKey: string | null;
  subject: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  sender: string;
  subject: string | null;
  bodyText: string;
  externalId: string | null;
  provider: string | null;
  createdAt: string;
}

function rowToConversation(row: Record<string, unknown>): ConversationRecord {
  return {
    id: String(row['id']),
    leadId: String(row['lead_id']),
    channel: String(row['channel']),
    externalThreadKey: (row['external_thread_key'] as string | null) ?? null,
    subject: (row['subject'] as string | null) ?? null,
    status: String(row['status']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function rowToMessage(row: Record<string, unknown>): MessageRecord {
  return {
    id: String(row['id']),
    conversationId: String(row['conversation_id']),
    direction: row['direction'] as 'inbound' | 'outbound',
    sender: String(row['sender']),
    subject: (row['subject'] as string | null) ?? null,
    bodyText: String(row['body_text']),
    externalId: (row['external_id'] as string | null) ?? null,
    provider: (row['provider'] as string | null) ?? null,
    createdAt: String(row['created_at']),
  };
}

export class ConversationRepository {
  constructor(private readonly db: Database) {}

  createForLead(leadId: string, channel: string, externalThreadKey?: string, subject?: string): ConversationRecord {
    const id = newId('cnv');
    const at = nowIso();
    this.db.run(
      `INSERT INTO conversations (id, lead_id, channel, external_thread_key, subject, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      id,
      leadId,
      channel,
      externalThreadKey ?? null,
      subject ?? null,
      at,
      at,
    );
    return this.requireById(id);
  }

  tryGetByLeadAndChannel(leadId: string, channel: string): ConversationRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      "SELECT * FROM conversations WHERE lead_id = ? AND channel = ? ORDER BY created_at DESC LIMIT 1",
      leadId,
      channel,
    );
    return row ? rowToConversation(row) : undefined;
  }

  requireById(id: string): ConversationRecord {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', id);
    if (!row) throw new Error(`conversation not found: ${id}`);
    return rowToConversation(row);
  }

  close(conversationId: string): void {
    this.db.run("UPDATE conversations SET status = 'closed', updated_at = ? WHERE id = ?", nowIso(), conversationId);
  }

  /**
   * Adds a message. Duplicate external IDs (webhook replays) are rejected by
   * the partial UNIQUE(conversation_id, external_id) index and return
   * undefined instead of inserting twice.
   */
  addMessage(input: {
    conversationId: string;
    direction: 'inbound' | 'outbound';
    sender: string;
    subject?: string;
    bodyText: string;
    externalId?: string;
    provider?: string;
  }): { message: MessageRecord; duplicate: false } | { message: undefined; duplicate: true } {
    const id = newId('msg');
    const at = nowIso();
    try {
      this.db.run(
        `INSERT INTO messages (id, conversation_id, direction, sender, subject, body_text, external_id, provider, processed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        id,
        input.conversationId,
        input.direction,
        input.sender,
        input.subject ?? null,
        input.bodyText,
        input.externalId ?? null,
        input.provider ?? null,
        at,
      );
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        return { message: undefined, duplicate: true };
      }
      throw err;
    }
    this.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', nowIso(), input.conversationId);
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM messages WHERE id = ?', id);
    return { message: rowToMessage(row!), duplicate: false };
  }

  /** Finds an existing inbound message by provider external id (replay path). */
  tryGetByExternalId(conversationId: string, externalId: string): MessageRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM messages WHERE conversation_id = ? AND external_id = ?',
      conversationId,
      externalId,
    );
    return row ? rowToMessage(row) : undefined;
  }

  /**
   * Thread resolution: finds the conversation owning an OUTBOUND message
   * with the given external id (our RFC Message-ID). Used to route inbound
   * replies by References/In-Reply-To before falling back to sender match.
   */
  tryFindConversationByOutboundExternalId(externalId: string): string | undefined {
    const row = this.db.get<Record<string, unknown>>(
      "SELECT conversation_id FROM messages WHERE external_id = ? AND direction = 'outbound'",
      externalId,
    );
    return row ? String(row['conversation_id']) : undefined;
  }

  markProcessed(messageId: string): void {
    this.db.run('UPDATE messages SET processed = 1 WHERE id = ?', messageId);
  }

  isProcessed(messageId: string): boolean {
    const row = this.db.get<{ processed: number }>('SELECT processed FROM messages WHERE id = ?', messageId);
    return Number(row?.processed ?? 0) === 1;
  }

  listMessages(conversationId: string, limit = 500): MessageRecord[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?',
        conversationId,
        limit,
      )
      .map(rowToMessage);
  }

  requireMessage(id: string): MessageRecord {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM messages WHERE id = ?', id);
    if (!row) throw new Error(`message not found: ${id}`);
    return rowToMessage(row);
  }
}
