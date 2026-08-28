import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '../../domain/errors.js';
import type { CheckoutSession, CreateCheckoutInput, ParsedPaymentEvent, PaymentProvider } from '../paymentProvider.js';

/**
 * Mock payment provider for development and tests.
 * - checkout references are deterministic per idempotency key;
 * - webhook signatures are HMAC-SHA256 over the raw body (hex), verified
 *   timing-safe — the same contract a real provider integration must honour;
 * - no network, no money movement.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly signatureHeader = 'x-mock-signature';
  private readonly sessions = new Map<string, CheckoutSession>();

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const existing = this.sessions.get(input.idempotencyKey);
    if (existing) return existing;
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new ValidationError('amountCents must be a positive integer');
    }
    const session: CheckoutSession = {
      providerReference: `mock_cs_${randomUUID()}`,
      checkoutUrl: `https://checkout.mock/pay/${encodeURIComponent(input.idempotencyKey)}?amount=${input.amountCents}&currency=${encodeURIComponent(input.currency)}`,
    };
    this.sessions.set(input.idempotencyKey, session);
    return session;
  }

  verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
    if (!secret || !signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseWebhookEvent(rawBody: string): ParsedPaymentEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new ValidationError('webhook body is not valid JSON');
    }
    const obj = parsed as Record<string, unknown>;
    const eventId = typeof obj['id'] === 'string' ? obj['id'] : '';
    const type = obj['type'];
    const reference = typeof obj['reference'] === 'string' ? obj['reference'] : '';
    if (!eventId || !reference || (type !== 'payment.succeeded' && type !== 'payment.failed')) {
      throw new ValidationError('webhook event is malformed');
    }
    return { eventId, type, reference };
  }

  /** Test/dev helper: produce a correctly signed webhook body. */
  static signEvent(event: { id: string; type: 'payment.succeeded' | 'payment.failed'; reference: string }, secret: string): { body: string; signature: string } {
    const body = JSON.stringify(event);
    const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    return { body, signature };
  }
}
