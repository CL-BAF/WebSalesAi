import { ValidationError } from '../domain/errors.js';
import { verifySvixWebhook, extractSvixHeaders } from './providers/svixVerify.js';
import type { ConversationService } from '../crm/conversationService.js';
import type { ConversationRepository } from '../db/repositories/conversations.js';
import type { AuditEventRepository } from '../db/repositories/auditEvents.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export interface ResendInboundDeps {
  config: AppConfig;
  conversations: ConversationRepository;
  conversationService: ConversationService;
  audit: AuditEventRepository;
  log: Logger;
  fetchImpl?: typeof fetch;
}

export interface ResendWebhookResult {
  status: 'processed' | 'duplicate' | 'unknown_sender' | 'failed' | 'ignored';
  httpStatus: number;
  detail?: Record<string, unknown>;
}

interface ReceivedEmailMetadata {
  email_id: string;
  from: string;
  to: string[];
  message_id?: string;
  subject?: string;
}

interface RetrievedEmail {
  id?: string;
  message_id?: string;
  from?: string;
  to?: string[];
  subject?: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string> | null;
}

/**
 * Resend inbound pipeline (production email replies):
 *   svix signature verification â†’ email.received event parse â†’ bounded
 *   content retrieval (GET /emails/{id}) â†’ plain-text normalization â†’
 *   thread resolution (References/In-Reply-To/message_id FIRST, normalized
 *   sender fallback, safe-fail) â†’ existing deterministic reply pipeline.
 *
 * Inbound email content is UNTRUSTED: it is passed to the Sales agent only
 * through the established wrapUntrusted pipeline, never as instructions.
 * The Resend API key is never logged and never echoed in errors.
 */
export class ResendInboundService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: ResendInboundDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Handles a raw /webhooks/resend request. Never throws. */
  async handleWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<ResendWebhookResult> {
    const secret = this.deps.config.resend.webhookSecret;
    if (!secret) {
      this.deps.audit.append({ actor: 'provider', actorType: 'provider', action: 'webhook.rejected', details: { reason: 'resend webhook secret not configured (fail-closed)' } });
      return { status: 'failed', httpStatus: 503, detail: { error: 'resend webhook not configured' } };
    }

    try {
      verifySvixWebhook(rawBody, extractSvixHeaders(headers), secret);
    } catch (err) {
      this.deps.audit.append({
        actor: 'provider',
        actorType: 'provider',
        action: 'webhook.rejected',
        details: { reason: 'svix verification failed', error: err instanceof Error ? err.message : String(err) },
      });
      return { status: 'failed', httpStatus: 401, detail: { error: 'invalid signature' } };
    }

    let event: { type?: unknown; data?: Partial<ReceivedEmailMetadata> };
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      return { status: 'ignored', httpStatus: 400, detail: { error: 'invalid JSON' } };
    }
    if (event.type !== 'email.received') {
      // Other Resend webhook types are acknowledged but out of scope.
      return { status: 'ignored', httpStatus: 200, detail: { type: String(event.type ?? 'unknown') } };
    }
    const meta = event.data ?? {};
    if (typeof meta.email_id !== 'string' || typeof meta.from !== 'string') {
      return { status: 'ignored', httpStatus: 400, detail: { error: 'missing email_id/from in event data' } };
    }

    this.deps.audit.append({
      actor: 'provider',
      actorType: 'provider',
      action: 'webhook.received',
      details: { kind: 'resend_inbound', emailId: meta.email_id, from: meta.from },
    });

    // Retrieve full content (bounded, authenticated, redacted on failure).
    let retrieved: RetrievedEmail;
    try {
      retrieved = await this.retrieveEmail(meta.email_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.audit.append({
        actor: 'provider',
        actorType: 'provider',
        action: 'error.occurred',
        details: { stage: 'resend_content_retrieval', emailId: meta.email_id, error: message },
      });
      return { status: 'failed', httpStatus: 502, detail: { error: 'content retrieval failed' } };
    }

    const bodyText = this.extractPlainText(retrieved);
    if (!bodyText.trim()) {
      this.deps.audit.append({ actor: 'provider', actorType: 'provider', action: 'webhook.received', details: { emailId: meta.email_id, note: 'no extractable plain text; ignored' } });
      return { status: 'ignored', httpStatus: 200, detail: { note: 'no plain text content' } };
    }

    // Thread hints ride along; ConversationService resolves thread-first
    // (References/In-Reply-To/message_id against stored outbound ids), then
    // falls back to normalized sender matching, then fails safe.
    const threadHints = this.collectThreadHints(retrieved, meta);
    const fromEmail = this.bareAddress(retrieved.from ?? meta.from);
    const result = await this.deps.conversationService.recordInboundReply({
      fromEmail,
      subject: retrieved.subject ?? meta.subject,
      body: bodyText,
      externalId: meta.email_id,
      provider: 'resend',
      threadHints,
    });
    if (result.outcome === 'unknown_sender') {
      return { status: 'unknown_sender', httpStatus: 422, detail: { outcome: 'unknown_sender' } };
    }
    if (result.outcome === 'failed') {
      return { status: 'failed', httpStatus: 502, detail: { outcome: 'failed', error: result.error } };
    }
    return { status: 'processed', httpStatus: 200, detail: { outcome: result.outcome === 'duplicate' ? 'duplicate' : result.outcome } };
  }

  /** GET /emails/{id} with auth, timeout, and a hard byte cap. */
  private async retrieveEmail(emailId: string): Promise<RetrievedEmail> {
    const apiKey = this.deps.config.resend.apiKey;
    if (!apiKey) throw new ValidationError('resend API key not configured');
    const maxBytes = this.deps.config.fetchMaxBytes;
    const res = await this.fetchImpl(`https://api.resend.com/emails/${encodeURIComponent(emailId)}`, {
      headers: { 'authorization': `Bearer ${apiKey}`, 'accept': 'application/json' },
      signal: AbortSignal.timeout(this.deps.config.fetchTimeoutMs),
    });
    if (!res.ok) {
      // Never echo the key; status only.
      throw new ValidationError(`resend retrieve failed with http ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new ValidationError(`inbound email content too large (${declared} bytes)`);
    const text = await res.text();
    if (text.length > maxBytes) throw new ValidationError('inbound email content too large');
    const parsed = JSON.parse(text) as RetrievedEmail;
    return parsed;
  }

  /** Normalized plain-text: prefer provider-parsed text; strip tags from HTML. */
  private extractPlainText(email: RetrievedEmail): string {
    if (email.text && email.text.trim()) {
      return email.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').slice(0, 100_000);
    }
    if (email.html) {
      // Minimal tag-strip (same approach as fetchSafe.htmlToText) â€” HTML is
      // NEVER passed to agents or rendered raw.
      return email.html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 100_000);
    }
    return '';
  }

  /** RFC ids that could identify the thread: References/In-Reply-To/message_id. */
  private collectThreadHints(email: RetrievedEmail, meta: { message_id?: string }): string[] {
    const hints = new Set<string>();
    const add = (v: unknown): void => {
      if (typeof v === 'string' && v.trim()) {
        for (const piece of v.split(/\s+/)) {
          const cleaned = piece.trim().toLowerCase();
          if (cleaned) hints.add(cleaned);
        }
      }
    };
    const headers = email.headers ?? {};
    add(headers['in-reply-to']);
    add(headers['references']);
    add(email.message_id ?? meta.message_id);
    return [...hints];
  }

  private bareAddress(from: string): string {
    const match = from.match(/<([^>]+)>/);
    const raw = match ? match[1]! : from;
    return raw.trim().toLowerCase();
  }
}

