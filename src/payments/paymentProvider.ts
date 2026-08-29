export interface CreateCheckoutInput {
  jobId: string;
  tier: string;
  amountCents: number;
  currency: string;
  description: string;
  /** Deterministic key — providers must not create twice for the same key. */
  idempotencyKey: string;
  successUrl: string;
}

export interface CheckoutSession {
  providerReference: string;
  checkoutUrl: string;
}

export interface ParsedPaymentEvent {
  eventId: string;
  type: 'payment.succeeded' | 'payment.failed';
  /** Provider reference of the checkout/payment this event belongs to. */
  reference: string;
  /** When available: the paid amount, validated against our payment row. */
  amountCents?: number;
  /** When available: the currency, validated against our payment row. */
  currency?: string;
  /** When available: provider metadata, validated against our payment row. */
  metadata?: Record<string, string>;
}

/**
 * Payment provider interface. The LLM may only REQUEST payment creation
 * through the workflow; the amount, currency and merchant come from
 * configuration, and payment status is accepted ONLY from signature-verified
 * webhook events — never from AI output. Stripe-style providers implement
 * this interface later.
 */
export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  /** Verifies an HMAC signature over the RAW request body (timing-safe). */
  verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean;
  /** Parses a verified webhook body into a typed event. */
  parseWebhookEvent(rawBody: string): ParsedPaymentEvent;
  /** The header name this provider uses for signatures. */
  readonly signatureHeader: string;
}
