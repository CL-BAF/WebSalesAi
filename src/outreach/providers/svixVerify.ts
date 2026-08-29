import { createHash, createHmac } from 'node:crypto';
import { Webhook as SvixWebhook } from 'svix';
import { ValidationError } from '../../domain/errors.js';

/**
 * Svix webhook signature verification (Resend's documented scheme):
 *   https://resend.com/docs/webhooks/verify-webhooks-requests
 *
 * Headers: `svix-id`, `svix-timestamp`, `svix-signature` (`v1,` + base64
 * HMAC-SHA256 over `${id}.${timestamp}.${payload}` with a `whsec_` signing
 * secret). Verification delegates to the OFFICIAL svix library (per A2),
 * which implements constant-time comparison and multi-signature (secret
 * rotation) handling. This wrapper adds:
 *  - fail-closed behaviour (missing config/headers → ValidationError);
 *  - an explicit replay check (timestamp within tolerance, never 0);
 *  - payload passthrough (callers own parsing).
 */

export interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export const SVIX_DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function extractSvixHeaders(headers: Record<string, string | string[] | undefined>): SvixHeaders {
  const get = (name: string): string => {
    const v = headers[name];
    return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
  };
  return {
    id: get('svix-id'),
    timestamp: get('svix-timestamp'),
    signature: get('svix-signature'),
  };
}

/**
 * Verifies a Svix-signed webhook. Throws ValidationError on any failure
 * (missing headers, malformed timestamp, expired tolerance, bad signature).
 * Returns the payload unchanged on success — callers own parsing.
 */
export function verifySvixWebhook(
  rawBody: string,
  headers: SvixHeaders,
  webhookSecret: string,
  opts: { toleranceSeconds?: number; now?: () => number } = {},
): void {
  if (!webhookSecret) throw new ValidationError('webhook secret not configured');
  if (!headers.id || !headers.timestamp || !headers.signature) {
    throw new ValidationError('missing svix webhook headers');
  }
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) {
    throw new ValidationError('malformed svix timestamp');
  }
  const tolerance = opts.toleranceSeconds ?? SVIX_DEFAULT_TOLERANCE_SECONDS;
  if (tolerance <= 0) throw new ValidationError('tolerance must be positive');
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  if (Math.abs(nowSec - timestamp) > tolerance) {
    throw new ValidationError('webhook timestamp outside tolerance (possible replay)');
  }

  try {
    // Official svix library: verifies `v1,` base64 HMAC-SHA256 over
    // `${id}.${timestamp}.${payload}` with the whsec_ secret, including
    // multi-signature (rotation) support.
    const wh = new SvixWebhook(webhookSecret);
    wh.verify(rawBody, {
      'svix-id': headers.id,
      'svix-timestamp': headers.timestamp,
      'svix-signature': headers.signature,
    });
  } catch (err) {
    throw new ValidationError(err instanceof Error ? `webhook verification failed: ${err.message}` : 'webhook signature mismatch');
  }
}

/**
 * Deterministic outbound Message-ID for threading. Derived from the
 * idempotency key so retries produce the same Message-ID.
 */
export function deterministicMessageId(idempotencyKey: string, senderDomain: string): string {
  const hash = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
  const domain = senderDomain.replace(/[^a-zA-Z0-9.-]/g, '') || 'websalesai.local';
  return `<wsa-${hash}@${domain}>`;
}

/** Signs a payload the way Svix does — used to generate test fixtures. */
export function signSvixPayload(rawBody: string, headers: SvixHeaders, webhookSecret: string): string {
  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const secret = webhookSecret.startsWith('whsec_') ? webhookSecret.slice('whsec_'.length) : webhookSecret;
  return createHmac('sha256', Buffer.from(secret, 'base64')).update(signedContent, 'utf8').digest('base64');
}