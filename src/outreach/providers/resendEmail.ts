import { ExternalActionError } from '../../domain/errors.js';
import type { EmailProvider, OutboundEmail, SentEmail } from '../emailProvider.js';
import { deterministicMessageId } from './svixVerify.js';

export interface ResendTransportOptions {
  apiKey: string;
  from: string;
  senderDomain: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  delayImpl?: (ms: number) => Promise<void>;
  log?: { debug(obj: unknown, msg: string): void };
}

class RetryableEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableEmailError';
  }
}

/**
 * Production email provider: Resend (https://resend.com).
 *
 * Docs (verified 2026-08):
 *  - Send: POST https://api.resend.com/emails, Bearer auth, response {id}.
 *  - Idempotency-Key header: unique per request, 24h provider-side expiry.
 *    NOTE (documented residual risk): after 24h the provider dedup expires â€”
 *    retries that old rely on our outbox claim discipline + stored
 *    providerMessageId, exactly like the documented crash-recovery window.
 *  - Threading: custom `headers` set Message-ID (deterministic per
 *    idempotency key), In-Reply-To and References when replying.
 *  - No secrets are ever included in error messages or logs.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  readonly signatureHeader = 'svix-signature';
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: ResendTransportOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '');
  }

  async send(email: OutboundEmail): Promise<SentEmail> {
    // Deterministic RFC Message-ID: stable across retries, and the value the
    // customer's mail client will reference in In-Reply-To/References.
    const messageId = deterministicMessageId(email.idempotencyKey, this.opts.senderDomain);
    const headers: Record<string, string> = { 'Message-ID': messageId };
    if (email.inReplyToMessageId) {
      headers['In-Reply-To'] = email.inReplyToMessageId;
      headers['References'] = email.inReplyToMessageId;
    }

    const body: Record<string, unknown> = {
      from: this.opts.from,
      to: [email.to],
      subject: email.subject,
      text: email.body,
      headers,
    };

    let attempt = 0;
    let lastError: Error = new ExternalActionError('resend transport did not run');
    const maxRetries = this.opts.retries ?? 2;
    for (;;) {
      try {
        const res = await this.once(body, email.idempotencyKey, messageId);
        return res;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const retryable = lastError instanceof RetryableEmailError;
        this.opts.log?.debug({ attempt, retryable, error: lastError.message }, 'resend email attempt failed');
        if (!retryable || attempt >= maxRetries) break;
        attempt++;
        const delay = Math.min(200 * 2 ** attempt + Math.floor(Math.random() * 200), 2000);
        await (this.opts.delayImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
      }
    }
    throw new ExternalActionError(`resend send failed: ${this.redact(lastError.message)}`);
  }

  private async once(body: Record<string, unknown>, idempotencyKey: string, messageId: string): Promise<SentEmail> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          'Idempotency-Key': idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new RetryableEmailError(isTimeout ? `timeout after ${this.opts.timeoutMs ?? 30_000}ms` : `connection error: ${this.redact(err instanceof Error ? err.message : 'unknown')}`);
    }

    if (res.status === 429 || res.status >= 500) {
      throw new RetryableEmailError(`resend http ${res.status}`);
    }
    if (!res.ok) {
      // 4xx: not retryable (auth/validation problems). Body is never echoed â€”
      // it could echo the API key context; keep the status only.
      throw new ExternalActionError(`resend request rejected with http ${res.status}`);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new ExternalActionError('resend returned a non-JSON response');
    }
    const id = (data as Record<string, unknown>)['id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new ExternalActionError('resend response missing email id');
    }
    // providerMessageId is our deterministic RFC Message-ID (set as the
    // Message-ID header): the identity the customer's mail client references
    // in In-Reply-To/References, enabling thread resolution. Resend's
    // internal {id} is retrievable via their API; provider-side duplicate
    // protection is governed by the Idempotency-Key header.
    void id;
    return { providerMessageId: messageId, acceptedAt: new Date().toISOString() };
  }

  /** Scrubs the configured API key from any text destined for errors/logs. */
  private redact(text: string): string {
    return text.split(this.opts.apiKey).join('[REDACTED]');
  }
}

