import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeWorld, seedQualifiedLead, sendFirstOutreach, type World } from './helpers/world.js';
import { MockPaymentProvider } from '../src/payments/providers/mockPayment.js';
import { PaymentService } from '../src/payments/paymentService.js';
import { PaymentRepository } from '../src/db/repositories/payments.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import type { AppConfig } from '../src/config.js';

const log = createLogger('error');

interface PaymentWorld {
  world: World;
  provider: MockPaymentProvider;
  payments: PaymentService;
  config: AppConfig;
  jobId: string;
}

function makePaymentWorld(paymentConfirmed = false, configOverrides: Record<string, string> = {}): PaymentWorld {
  const world = makeWorld({ configOverrides: { OUTREACH_ENABLED: 'true', PAYMENT_WEBHOOK_SECRET: 'whsec_test_123', ...configOverrides } });
  const provider = new MockPaymentProvider();
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
  void paymentConfirmed;
  return { world, provider, payments, config: world.config, jobId: '' };
}

async function seedToClientApproved(w: PaymentWorld): Promise<void> {
  const { leadId, jobId } = seedQualifiedLead(w.world);
  w.jobId = jobId;
  await sendFirstOutreach(w.world, leadId);
  for (const state of ['CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD'] as const) {
    w.world.engine.transition(jobId, state, { actor: 'system', actorType: 'system' });
  }
  // We do not need a real website for payment tests; the state machine path
  // PREVIEW_READY â†’ ... â†’ CLIENT_APPROVED is exercised in the deploy tests.
  for (const state of ['BUILDING', 'REVIEWING', 'PREVIEW_READY', 'PREVIEW_SENT', 'AWAITING_CLIENT_APPROVAL', 'CLIENT_APPROVED'] as const) {
    w.world.engine.transition(jobId, state, { actor: 'system', actorType: 'system' });
  }
}

describe('payment stage (deterministic)', () => {
  let w: PaymentWorld;

  beforeEach(async () => {
    w = makePaymentWorld();
    await seedToClientApproved(w);
  });

  test('creates checkout at CONFIGURED price from CLIENT_APPROVED state', async () => {
    const runsBefore = w.world.runs.listByJob(w.jobId).length;
    const res = await w.payments.createPaymentRequest(w.jobId, 'business');
    assert.equal(res.created, true);
    assert.equal(res.amountCents, w.config.pricing.tiers['business']);
    assert.equal(res.currency, 'USD');
    assert.ok(res.checkoutUrl);
    assert.equal(w.world.jobs.requireById(w.jobId).state, 'AWAITING_PAYMENT');
    assert.ok(w.world.audit.listForJob(w.jobId).some((e) => e.action === 'payment.request_created'));
    // No AI involvement in the payment path: no new agent runs created.
    assert.equal(w.world.runs.listByJob(w.jobId).length, runsBefore);
  });

  test('payment creation is idempotent per job', async () => {
    const r1 = await w.payments.createPaymentRequest(w.jobId, 'business');
    const r2 = await w.payments.createPaymentRequest(w.jobId, 'business');
    assert.equal(r1.checkoutUrl, r2.checkoutUrl);
    const count = w.world.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM payments')?.c;
    assert.equal(count, 1);
  });

  test('rejects unknown tiers and wrong state', async () => {
    // Unknown tier (state is still CLIENT_APPROVED, so the tier check is reached).
    await assert.rejects(() => w.payments.createPaymentRequest(w.jobId, 'diamond'), /unknown pricing tier/);
    // Create one payment: the job now sits in AWAITING_PAYMENT.
    const created = await w.payments.createPaymentRequest(w.jobId, 'business');
    // A repeat call from AWAITING_PAYMENT is an IDEMPOTENT REPLAY of the same
    // checkout — no second payment row, same URL, same tier.
    const replay = await w.payments.createPaymentRequest(w.jobId, 'starter');
    assert.equal(replay.tier, 'business', 'replay returns the original tier');
    assert.equal(replay.checkoutUrl, created.checkoutUrl);
    // Wrong state: a fresh job can never create a payment.
    const fresh = seedQualifiedLead(w.world);
    await assert.rejects(() => w.payments.createPaymentRequest(fresh.jobId, 'business'), /CLIENT_APPROVED/);
    const count = w.world.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM payments')?.c;
    assert.equal(count, 1);
  });

  test('webhook: signed success event confirms payment via provider actor', async () => {
    await w.payments.createPaymentRequest(w.jobId, 'starter');
    const payment = w.world.db.get<{ reference: string }>("SELECT provider_reference AS reference FROM payments")!;
    const event = { id: 'evt_1', type: 'payment.succeeded' as const, reference: payment.reference };
    const { body, signature } = MockPaymentProvider.signEvent(event, 'whsec_test_123');
    const res = await w.payments.handleWebhook(body, signature);
    assert.deepEqual(res, { handled: true, jobId: w.jobId, paymentStatus: 'paid', duplicate: false });
    assert.equal(w.world.jobs.requireById(w.jobId).state, 'PAYMENT_CONFIRMED');
    assert.ok(w.world.audit.listForJob(w.jobId).some((e) => e.action === 'payment.confirmed' && e.actorType === 'provider'));
    assert.equal(w.payments.isPaymentConfirmed(w.jobId), true);
    void createHash;
  });

  test('webhook: duplicate event id is deduplicated (no double transition)', async () => {
    await w.payments.createPaymentRequest(w.jobId, 'starter');
    const payment = w.world.db.get<{ reference: string }>("SELECT provider_reference AS reference FROM payments")!;
    const event = { id: 'evt_dup', type: 'payment.succeeded' as const, reference: payment.reference };
    const { body, signature } = MockPaymentProvider.signEvent(event, 'whsec_test_123');
    const r1 = await w.payments.handleWebhook(body, signature);
    assert.equal(r1.handled, true);
    const r2 = await w.payments.handleWebhook(body, signature);
    assert.deepEqual(r2, { handled: false, duplicate: true });
    assert.equal(w.world.jobs.requireById(w.jobId).state, 'PAYMENT_CONFIRMED');
    const confirmations = w.world.audit.listForJob(w.jobId).filter((e) => e.action === 'payment.confirmed');
    assert.equal(confirmations.length, 1);
  });

  test('webhook: invalid signature is rejected fail-closed', async () => {
    await w.payments.createPaymentRequest(w.jobId, 'starter');
    const payment = w.world.db.get<{ reference: string }>("SELECT provider_reference AS reference FROM payments")!;
    const event = { id: 'evt_bad', type: 'payment.succeeded' as const, reference: payment.reference };
    const { body } = MockPaymentProvider.signEvent(event, 'whsec_test_123');
    const res = await w.payments.handleWebhook(body, 'deadbeef');
    assert.deepEqual(res, { handled: false, reason: 'invalid signature' });
    assert.equal(w.world.jobs.requireById(w.jobId).state, 'AWAITING_PAYMENT');
    assert.ok(w.world.audit.listRecent(10).some((e) => e.action === 'webhook.rejected'));
  });

  test('webhook: fail-closed when no secret configured', async () => {
    const open = makePaymentWorld(false, { PAYMENT_WEBHOOK_SECRET: '' });
    await seedToClientApproved(open);
    await open.payments.createPaymentRequest(open.jobId, 'starter');
    const res = await open.payments.handleWebhook('{"id":"x","type":"payment.succeeded","reference":"r"}', 'sig');
    assert.deepEqual(res, { handled: false, reason: 'webhook secret not configured' });
  });

  test('webhook: failed payment marks payment failed, job stays AWAITING_PAYMENT', async () => {
    await w.payments.createPaymentRequest(w.jobId, 'starter');
    const payment = w.world.db.get<{ reference: string }>("SELECT provider_reference AS reference FROM payments")!;
    const event = { id: 'evt_fail', type: 'payment.failed' as const, reference: payment.reference };
    const { body, signature } = MockPaymentProvider.signEvent(event, 'whsec_test_123');
    const res = await w.payments.handleWebhook(body, signature);
    assert.deepEqual(res, { handled: true, jobId: w.jobId, paymentStatus: 'failed', duplicate: false });
    assert.equal(w.world.jobs.requireById(w.jobId).state, 'AWAITING_PAYMENT');
    assert.equal(w.payments.isPaymentConfirmed(w.jobId), false);
  });

  test('webhook: unknown reference is recorded but not applied', async () => {
    const event = { id: 'evt_unknown', type: 'payment.succeeded' as const, reference: 'mock_cs_unknown' };
    const { body, signature } = MockPaymentProvider.signEvent(event, 'whsec_test_123');
    const res = await w.payments.handleWebhook(body, signature);
    assert.deepEqual(res, { handled: false, reason: 'unknown payment reference' });
  });
});

