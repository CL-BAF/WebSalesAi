import Stripe from 'stripe';
import { ValidationError } from '../../domain/errors.js';
import type { CheckoutSession, CreateCheckoutInput, ParsedPaymentEvent, PaymentProvider } from '../paymentProvider.js';

export interface StripeProviderOptions {
  secretKey: string;
  /** Injectable for offline tests. */
  stripeClient?: Stripe;
}

const SUCCEEDED_EVENTS = new Set(['checkout.session.completed']);
const FAILED_EVENTS = new Set(['checkout.session.expired', 'checkout.session.async_payment_failed']);

/**
 * Production payment provider: Stripe Hosted Checkout.
 *
 * Docs (verified 2026-08):
 *  - Checkout Session create: https://docs.stripe.com/api/checkout/sessions/create
 *    (mode='payment', line_items[].price_data.{currency,unit_amount}, metadata,
 *    client_reference_id, success_url). Card data NEVER touches WebSalesAi â€”
 *    the customer pays on Stripe's hosted page.
 *  - Webhooks: https://docs.stripe.com/webhooks â€” `Stripe-Signature`
 *    (t=,v1=) HMAC-SHA256 over `${t}.${rawBody}` with a `whsec_â€¦` secret,
 *    5-minute default tolerance (never 0), constant-time compare, multiple
 *    v1 signatures during rotation, RAW BODY required. Verification uses the
 *    official SDK (`stripe.webhooks.constructEvent`) â€” the documented
 *    recommended path.
 *  - Only required event types are subscribed per docs guidance:
 *    checkout.session.completed / expired / async_payment_failed.
 *  - Idempotency: session creation passes our deterministic idempotency key.
 *
 * Amount/currency/tier always come from the caller (deterministic config) â€”
 * never from AI output. Event reference = checkout session id, which matches
 * our stored provider_reference.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly signatureHeader = 'stripe-signature';
  private readonly stripe: Stripe;

  constructor(private readonly opts: StripeProviderOptions) {
    this.stripe = opts.stripeClient ?? new Stripe(opts.secretKey);
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new ValidationError('amountCents must be a positive integer');
    }
    // Deterministic idempotency key: retries can never create a second session.
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amountCents,
              product_data: { name: input.description.slice(0, 200) },
            },
          },
        ],
        metadata: {
          job_id: input.jobId,
          pricing_tier: input.tier,
          idempotency_key: input.idempotencyKey,
        },
        client_reference_id: input.idempotencyKey,
        success_url: input.successUrl,
      },
      { idempotencyKey: `wsa-${input.idempotencyKey}`.slice(0, 255) },
    );
    if (!session.url) {
      throw new ValidationError('stripe did not return a checkout URL');
    }
    return { providerReference: session.id, checkoutUrl: session.url };
  }

  verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
    if (!secret || !signature) return false;
    try {
      // Official SDK: handles tolerance (5 min default, never 0), constant-time
      // compare, and multiple v1 signatures during secret rotation.
      this.stripe.webhooks.constructEvent(rawBody, signature, secret);
      return true;
    } catch {
      return false;
    }
  }

  parseWebhookEvent(rawBody: string): ParsedPaymentEvent {
    let event: Stripe.Event;
    try {
      event = JSON.parse(rawBody) as Stripe.Event;
    } catch {
      throw new ValidationError('stripe webhook body is not valid JSON');
    }
    const succeeded = SUCCEEDED_EVENTS.has(event.type);
    const failed = FAILED_EVENTS.has(event.type);
    if (!succeeded && !failed) {
      throw new ValidationError(`unhandled stripe event type: ${event.type}`);
    }
    const object = event.data?.object as
      | { id?: unknown; amount_total?: unknown; currency?: unknown; metadata?: unknown }
      | undefined;
    const reference = typeof object?.['id'] === 'string' ? object['id'] : '';
    if (!event.id || !reference) {
      throw new ValidationError('stripe webhook event is missing id/reference');
    }
    const parsed: ParsedPaymentEvent = {
      eventId: event.id,
      type: succeeded ? 'payment.succeeded' : 'payment.failed',
      reference,
    };
    if (typeof object?.['amount_total'] === 'number') {
      parsed.amountCents = object['amount_total'];
    }
    if (typeof object?.['currency'] === 'string') {
      parsed.currency = object['currency'];
    }
    const metadata = object?.['metadata'];
    if (metadata && typeof metadata === 'object') {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
        if (typeof v === 'string') flat[k] = v;
      }
      if (Object.keys(flat).length > 0) parsed.metadata = flat;
    }
    return parsed;
  }
}

