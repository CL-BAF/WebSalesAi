import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StripePaymentProvider } from '../src/payments/providers/stripePayment.js';
import { PaymentService } from '../src/payments/paymentService.js';
import { PaymentRepository } from '../src/db/repositories/payments.js';
import { makeWorld, seedQualifiedLead, sendFirstOutreach } from './helpers/world.js';
import { createLogger } from '../src/logger.js';
import type { CreateCheckoutInput, ParsedPaymentEvent, PaymentProvider } from '../src/payments/paymentProvider.js';
import type Stripe from 'stripe';

const log = createLogger('error');

// ---------------------------------------------------------------------------
// Unit: StripePaymentProvider against a contract-shaped fake SDK client
// ---------------------------------------------------------------------------

const SAMPLE: CreateCheckoutInput = {
  jobId: 'job_abc',
  tier: 'business',
  amountCents: 89900,
  currency: 'AUD',
  description: 'Website package (business) for job job_abc',
  idempotencyKey: 'payment:create:job_abc',
  successUrl: 'https://wsa.example/success/job_abc',
};

function fakeStripe(overrides: { createThrows?: Error; captured?: { params?: unknown; opts?: unknown }; verifyBehavior?: 'ok' | 'fail' } = {}): Stripe {
  const captured = overrides.captured ?? {};
  const client = {
    checkout: {
      sessions: {
        create: async (params: unknown, opts: unknown) => {
          captured.params = params;
          captured.opts = opts;
          if (overrides.createThrows) throw overrides.createThrows;
          return { id: 'cs_test_abc123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
        },
      },
    },
    webhooks: {
      constructEvent: (rawBody: string, signature: string, secret: string) => {
        if (overrides.verifyBehavior === 'fail') throw new Error('Signature verification failed');
        void signature;
        void secret;
        return JSON.parse(rawBody) as object;
      },
    },
  };
  return client as unknown as Stripe;
}

describe('stripe provider: hosted checkout creation', () => {
  test('session built from CALLER-provided amount/currency; deterministic metadata + idempotency key', async () => {
    const captured: { params?: unknown; opts?: unknown } = {};
    const provider = new StripePaymentProvider({ secretKey: 'sk_test_placeholder', stripeClient: fakeStripe({ captured }) });
    const session = await provider.createCheckout(SAMPLE);

    const params = captured.params as {
      mode: string;
      line_items: Array<{ quantity: number; price_data: { currency: string; unit_amount: number } }>;
      metadata: Record<string, string>;
      client_reference_id: string;
      success_url: string;
    };
    const opts = captured.opts as { idempotencyKey: string };

    assert.equal(params.mode, 'payment', 'hosted Checkout, one-time payment');
    assert.equal(params.line_items[0]!.price_data.currency, 'aud');
    assert.equal(params.line_items[0]!.price_data.unit_amount, 89900, 'amount arrives from deterministic config, never computed by AI');
    assert.equal(params.line_items[0]!.quantity, 1);
    assert.equal(params.metadata['job_id'], 'job_abc');
    assert.equal(params.metadata['pricing_tier'], 'business');
    assert.equal(params.metadata['idempotency_key'], 'payment:create:job_abc');
    assert.equal(params.client_reference_id, 'payment:create:job_abc');
    assert.equal(params.success_url, SAMPLE.successUrl);
    assert.match(opts.idempotencyKey, /^wsa-payment:create:job_abc/, 'retries can never create a second session');
    assert.match(session.providerReference, /^cs_test_/);
    assert.ok(session.checkoutUrl.includes('checkout.stripe.com'));
  });

  test('no card data passes through WebSalesAi (hosted page owns the card experience)', async () => {
    const captured: { params?: unknown; opts?: unknown } = {};
    const provider = new StripePaymentProvider({ secretKey: 'sk_test_placeholder', stripeClient: fakeStripe({ captured }) });
    await provider.createCheckout(SAMPLE);
    const body = JSON.stringify(captured.params);
    assert.ok(!body.includes('"card"'), 'no payment-method data in the session payload');
    assert.ok(!(body as string).includes('payment_method'), 'no payment_method fields');
  });

  test('non-integer / non-positive amounts rejected before any API call', async () => {
    const provider = new StripePaymentProvider({ secretKey: 'sk_test_x', stripeClient: fakeStripe() });
    await assert.rejects(() => provider.createCheckout({ ...SAMPLE, amountCents: 0 }), /positive integer/);
    await assert.rejects(() => provider.createCheckout({ ...SAMPLE, amountCents: 10.5 }), /positive integer/);
  });

  test('webhook verification: valid true; invalid/missing header/missing secret false (fail-closed)', () => {
    const ok = new StripePaymentProvider({ secretKey: 'sk_test_x', stripeClient: fakeStripe({ verifyBehavior: 'ok' }) });
    assert.equal(ok.verifyWebhookSignature('{}', 't=1,v1=ok', 'whsec_x'), true);
    const failing = new StripePaymentProvider({ secretKey: 'sk_test_x', stripeClient: fakeStripe({ verifyBehavior: 'fail' }) });
    assert.equal(failing.verifyWebhookSignature('{"x":1}', 't=1,v1=bad', 'whsec_x'), false, 'invalid signature rejected by SDK → false');
    assert.equal(failing.verifyWebhookSignature('{}', '', 'whsec_x'), false, 'missing header rejected');
    assert.equal(failing.verifyWebhookSignature('{}', 't=1,v1=x', ''), false, 'missing secret rejected (fail-closed)');
  });

  test('parseWebhookEvent: completed → succeeded with amount/currency/metadata; expired + async_payment_failed → failed; other types rejected', () => {
    const provider = new StripePaymentProvider({ secretKey: 'sk_test_x', stripeClient: fakeStripe() });
    const completed = {
      id: 'evt_ok',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_123', amount_total: 89900, currency: 'aud', metadata: { job_id: 'job_abc', pricing_tier: 'business', idempotency_key: 'payment:create:job_abc' } } },
    };
    const parsed = provider.parseWebhookEvent(signedEvent(completed));
    assert.equal(parsed.type, 'payment.succeeded');
    assert.equal(parsed.reference, 'cs_test_123');
    assert.equal(parsed.eventId, 'evt_ok');
    assert.equal(parsed.amountCents, 89900);
    assert.equal(parsed.currency, 'aud');
    assert.equal(parsed.metadata?.['pricing_tier'], 'business');

    const expired = { id: 'evt_x', type: 'checkout.session.expired', data: { object: { id: 'cs_test_123' } } };
    assert.equal(provider.parseWebhookEvent(signedEvent(expired)).type, 'payment.failed');
    const asyncFailed = { id: 'evt_y', type: 'checkout.session.async_payment_failed', data: { object: { id: 'cs_test_123' } } };
    assert.equal(provider.parseWebhookEvent(signedEvent(asyncFailed)).type, 'payment.failed');
    const unrelated = { id: 'evt_z', type: 'customer.created', data: { object: { id: 'cus_1' } } };
    assert.throws(() => provider.parseWebhookEvent(signedEvent(unrelated)), /unhandled stripe event type/);
    assert.throws(() => provider.parseWebhookEvent('not-json'), /not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// Service-level integration: cross-validation with an event-driven provider
// fake (same interface contract as the Stripe adapter, no SDK in the loop)
// ---------------------------------------------------------------------------

const SECRET = 'whsec_test_integration';
const REAL_PAYLOAD = '{"verified":"by the fake provider signature check"}';

interface Harness {
  world: ReturnType<typeof makeWorld>;
  payments: PaymentService;
  jobId: string;
  setEvent: (event: ParsedPaymentEvent) => void;
  reference: () => { reference: string; amount: number; currency: string; tier: string; key: string };
  sessionCount: () => number;
  setCreateFailure: (err: Error) => void;
}

async function makeHarness(options: { failFirstCreate?: Error } = {}): Promise<Harness> {
  const world = makeWorld({ configOverrides: { OUTREACH_ENABLED: 'true', PAYMENT_WEBHOOK_SECRET: SECRET } });
  let sessions = 0;
  let createError: Error | undefined = options.failFirstCreate;
  let currentEvent: ParsedPaymentEvent = { eventId: 'evt_none', type: 'payment.succeeded', reference: 'none' };
  const provider: PaymentProvider = {
    name: 'stripe',
    signatureHeader: 'stripe-signature',
    createCheckout: async (input) => {
      if (createError) {
        const err = createError;
        createError = undefined;
        throw err;
      }
      sessions++;
      return { providerReference: `cs_test_${input.jobId}`, checkoutUrl: 'https://checkout.stripe.com/c/pay/test-session' };
    },
    verifyWebhookSignature: (rawBody, signature) => signature === 'valid' && rawBody.length > 0,
    parseWebhookEvent: () => currentEvent,
  };
  const payments = new PaymentService({
    config: world.config,
    db: world.db,
    jobs: world.jobs,
    payments: new PaymentRepository(world.db),
    idempotency: world.idempotency,
    engine: world.engine,
    audit: world.audit,
    paymentProvider: provider,
    log,
  });
  const { leadId, jobId } = seedQualifiedLead(world);
  await sendFirstOutreach(world, leadId);
  // sendFirstOutreach left the job at AWAITING_REPLY (OUTREACH_SENT → reply wait).
  for (const state of ['CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD', 'BUILDING', 'REVIEWING', 'PREVIEW_READY', 'PREVIEW_SENT', 'AWAITING_CLIENT_APPROVAL', 'CLIENT_APPROVED'] as const) {
    world.engine.transition(jobId, state, { actor: 'system', actorType: 'system' });
  }
  return {
    world,
    payments,
    jobId,
    setEvent: (e) => {
      currentEvent = e;
    },
    reference: () => {
      const row = world.db.get<{ reference: string; amount: number; currency: string; tier: string; key: string }>(
        'SELECT provider_reference AS reference, amount_cents AS amount, currency, tier, idempotency_key AS key FROM payments',
      );
      assert.ok(row, 'payment row must exist');
      return { reference: row.reference, amount: Number(row.amount), currency: String(row.currency), tier: String(row.tier), key: String(row.key) };
    },
    sessionCount: () => sessions,
    setCreateFailure: (err) => {
      createError = err;
    },
  };
}

describe('S4 integration: PaymentService with stripe-shaped event provider', () => {
  test('M8-1 resume: provider failure after transition → retry resumes, exactly one session and transition', async () => {
    const h = await makeHarness({ failFirstCreate: new Error('stripe api timeout') });
    await assert.rejects(() => h.payments.createPaymentRequest(h.jobId, 'business'), /stripe api timeout/);
    assert.equal(h.world.jobs.requireById(h.jobId).state, 'AWAITING_PAYMENT', 'state committed before the provider call');

    const resumed = await h.payments.createPaymentRequest(h.jobId, 'business');
    assert.equal(resumed.created, true);
    assert.ok(resumed.checkoutUrl);
    assert.equal(h.world.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM payments')?.c, 1, 'exactly one payment row');
    const transitions = h.world.audit
      .listForJob(h.jobId)
      .filter((e) => e.action === 'state.transition' && e.details?.['to'] === 'AWAITING_PAYMENT');
    assert.equal(transitions.length, 1, 'no duplicate transition');
    assert.equal(h.sessionCount(), 1, 'exactly one checkout session (idempotency key governs)');
  });

  test('full webhook matrix: valid applies; wrong amount/currency/metadata refused; stale failure after paid ignored', async () => {
    const h = await makeHarness();
    const created = await h.payments.createPaymentRequest(h.jobId, 'business');
    assert.ok(created.checkoutUrl);
    const pay = h.reference();
    assert.match(pay.reference, /^cs_test_/);

    // Wrong amount → recorded, refused, not applied.
    h.setEvent({ eventId: 'evt_amount', type: 'payment.succeeded', reference: pay.reference, amountCents: pay.amount + 1, currency: pay.currency, metadata: { job_id: h.jobId, idempotency_key: pay.key, pricing_tier: pay.tier } });
    const wrongAmount = await h.payments.handleWebhook(REAL_PAYLOAD, 'valid');
    assert.equal(wrongAmount.code, 'validation_mismatch');
    assert.match(wrongAmount.reason ?? '', /amount/);
    assert.equal(h.world.payments.isPaid(h.jobId), false);

    // Wrong currency → refused.
    h.setEvent({ eventId: 'evt_currency', type: 'payment.succeeded', reference: pay.reference, amountCents: pay.amount, currency: 'NZD', metadata: { job_id: h.jobId, idempotency_key: pay.key, pricing_tier: pay.tier } });
    const wrongCurrency = await h.payments.handleWebhook(REAL_PAYLOAD, 'valid');
    assert.equal(wrongCurrency.code, 'validation_mismatch');
    assert.match(wrongCurrency.reason ?? '', /currency/);

    // Wrong metadata (foreign job) → refused.
    h.setEvent({ eventId: 'evt_meta', type: 'payment.succeeded', reference: pay.reference, amountCents: pay.amount, currency: pay.currency, metadata: { job_id: 'job_forged', idempotency_key: pay.key, pricing_tier: pay.tier } });
    const wrongMeta = await h.payments.handleWebhook(REAL_PAYLOAD, 'valid');
    assert.equal(wrongMeta.code, 'validation_mismatch');
    assert.match(wrongMeta.reason ?? '', /job_id/);

    // Valid (currency case-insensitive) → applied via provider actor.
    h.setEvent({ eventId: 'evt_ok', type: 'payment.succeeded', reference: pay.reference, amountCents: pay.amount, currency: pay.currency.toLowerCase(), metadata: { job_id: h.jobId, idempotency_key: pay.key, pricing_tier: pay.tier } });
    const valid = await h.payments.handleWebhook(REAL_PAYLOAD, 'valid');
    assert.equal(valid.code, 'applied');
    assert.equal((valid as { paymentStatus: string }).paymentStatus, 'paid');
    assert.equal(h.world.jobs.requireById(h.jobId).state, 'PAYMENT_CONFIRMED');
    assert.equal(h.world.payments.isPaid(h.jobId), true);
    assert.ok(
      h.world.audit.listForJob(h.jobId).some((e) => e.action === 'webhook.rejected' && Array.isArray(e.details?.['mismatches'])),
      'each mismatch audited',
    );

    // M8-2: stale failed event under a fresh id after paid → stays paid.
    h.setEvent({ eventId: 'evt_stale_fail', type: 'payment.failed', reference: pay.reference });
    const stale = await h.payments.handleWebhook(REAL_PAYLOAD, 'valid');
    assert.equal(stale.code, 'idempotent_noop', 'stale failure ignored');
    assert.equal((stale as { paymentStatus: string }).paymentStatus, 'paid');
    const rowAfter = h.world.db.get<{ status: string }>('SELECT status FROM payments')!;
    assert.equal(rowAfter.status, 'paid');

    // Duplicate success under a fresh event id → idempotent no-op, one confirmation.
    h.setEvent({ eventId: 'evt_dup_success', type: 'payment.succeeded', reference: pay.reference, amountCents: pay.amount, currency: pay.currency, metadata: { job_id: h.jobId, idempotency_key: pay.key, pricing_tier: pay.tier } });
    const dup = await h.payments.handleWebhook(REAL_PAYLOAD, 'valid');
    assert.equal(dup.code, 'idempotent_noop');
    const confirmations = h.world.audit.listForJob(h.jobId).filter((e) => e.action === 'payment.confirmed');
    assert.equal(confirmations.length, 1, 'exactly one payment.confirmed audit');
  });

  test('duplicate event id is deduplicated (Stripe retries up to 3 days); unknown reference inert', async () => {
    const h = await makeHarness({});
    const created = await h.payments.createPaymentRequest(h.jobId, 'starter');
    const pay = h.reference();
    assert.equal(created.checkoutUrl.includes('checkout.stripe.com'), true);

    h.setEvent({ eventId: 'evt_dup', type: 'payment.succeeded', reference: pay.reference, amountCents: pay.amount, currency: pay.currency, metadata: { job_id: h.jobId, idempotency_key: pay.key, pricing_tier: pay.tier } });
    const first = await h.payments.handleWebhook(REAL_PAYLOAD, 'valid');
    assert.equal(first.code, 'applied');
    const replay = await h.payments.handleWebhook(REAL_PAYLOAD, 'valid');
    assert.equal(replay.code, 'duplicate_event');

    // Unknown session reference (another Stripe account / deleted session):
    // recorded, inert, 200 at the route layer.
    h.setEvent({ eventId: 'evt_unknown', type: 'payment.succeeded', reference: 'cs_test_foreign' });
    const unknown = await h.payments.handleWebhook(REAL_PAYLOAD, 'valid');
    assert.equal(unknown.code, 'unknown_reference');
  });

  test('missing webhook secret → fail-closed; invalid signature → rejected without state change', async () => {
    const h = await makeHarness();
    await h.payments.createPaymentRequest(h.jobId, 'starter');
    h.setEvent({ eventId: 'evt_bad', type: 'payment.succeeded', reference: h.reference().reference });
    const badSig = await h.payments.handleWebhook(REAL_PAYLOAD, 'invalid');
    assert.equal(badSig.code, 'invalid_signature');
    assert.equal(h.world.jobs.requireById(h.jobId).state, 'AWAITING_PAYMENT');

    // No secret configured at all: separate world without PAYMENT_WEBHOOK_SECRET.
    const open = makeWorld({ configOverrides: { OUTREACH_ENABLED: 'true' } });
    const payments = new PaymentService({
      config: open.config, db: open.db, jobs: open.jobs,
      payments: new PaymentRepository(open.db), idempotency: open.idempotency,
      engine: open.engine, audit: open.audit, paymentProvider: {
        name: 'stripe', signatureHeader: 'stripe-signature',
        createCheckout: async () => ({ providerReference: 'cs_test_x', checkoutUrl: 'https://x' }),
        verifyWebhookSignature: () => true,
        parseWebhookEvent: () => ({ eventId: 'e', type: 'payment.succeeded', reference: 'x' }),
      }, log,
    });
    const res = await payments.handleWebhook('{}', 'any');
    assert.equal(res.code, 'not_configured');
  });
});

function signedEvent(payload: unknown): string {
  return JSON.stringify(payload);
}

function falseAlternate(): boolean {
  return false;
}
function falseAlternate2() {}
void falseAlternate2;