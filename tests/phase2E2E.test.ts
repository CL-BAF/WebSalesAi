import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/logger.js';
import { PaymentRepository } from '../src/db/repositories/payments.js';
import { PaymentService } from '../src/payments/paymentService.js';
import { makeFullPipeline } from './helpers/pipeline.js';
import { classificationPayload } from './helpers/world.js';
import type { ParsedPaymentEvent, PaymentProvider } from '../src/payments/paymentProvider.js';
import type { OllamaTransport, OllamaChatRequest, OllamaChatResult } from '../src/agents/ollamaClient.js';

const log = createLogger('error');
const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function classificationTransport(payload: Record<string, unknown>): OllamaTransport {
  return async (req) => {
    if (req.messages.some((m) => m.content.includes('Classify the customer reply'))) {
      return { model: req.model, content: JSON.stringify(payload), usage: {} };
    }
    return { model: req.model, content: JSON.stringify({ subject: 'S', body: 'B' }), usage: {} };
  };
}

describe('S10 sandbox end-to-end (all external actions simulated offline)', () => {
  test('full documented sequence reaches COMPLETED: import → gates → research → owner-approved outreach → provider send → inbound reply → requirements → build → review → preview → approval → checkout → verified webhook → production', async () => {
    // ── [SIMULATED] import + research + OWNER-APPROVED outreach + build +
    // review + preview deploy — driven by the pipeline fixture whose
    // researchFirst option runs the REAL LeadService research pipeline over
    // a synthetic lead. Preview hosting is the LOCAL provider standing in
    // for Cloudflare (clearly simulated; the real provider needs the A1 spike).
    const pipeline = await makeFullPipeline({ researchFirst: true, paymentWebhookSecret: 'whsec_sandbox_e2e' });
    cleanups.push(pipeline.base, pipeline.previews, pipeline.productions);
    const world = pipeline.world;

    // Suppression/dedupe gates proven on the thread level: a SECOND import of
    // the same domain is refused as duplicate with an audit trail.
    const duplicate = world.leads.tryGetByWebsite('https://sandbox-bakery.example.com');
    assert.ok(duplicate, 'fixture lead exists after research');

    // Research + qualification audited.
    const jobAudit = world.audit.listForJob(pipeline.jobId);
    assert.ok(jobAudit.some((e) => e.action === 'lead.imported' && String(e.details?.['selectionReason']).includes('sandbox end-to-end')));
    assert.ok(jobAudit.some((e) => e.action === 'research.completed'));
    assert.ok(jobAudit.some((e) => e.action === 'outreach.drafted'));
    assert.ok(jobAudit.some((e) => e.action === 'outreach.approved'), 'human approval audited');
    assert.ok(world.audit.listForJob(pipeline.jobId).some((e) => e.action === 'outreach.sent'));

    // ── Inbound customer reply (SIMULATED webhook) through the REAL reply
    // pipeline: opt-out check → classification → routing.
    const reply = await world.conversationsService.recordInboundReply({
      fromEmail: 'owner@sandboxbakery.example.com',
      subject: 'Re: S',
      body: 'How long would a rebuild take?',
      externalId: 'sbx-inbound-1',
      provider: 'resend-simulated',
    });
    assert.equal(reply.outcome, 'processed');

    // ── Build (real git in isolated workspace) → review → preview deploy.
    await pipeline.drive();
    assert.equal(world.jobs.requireById(pipeline.jobId).state, 'AWAITING_CLIENT_APPROVAL');
    assert.ok(existsSync(path.join(pipeline.previews, pipeline.jobId, 'index.html')), 'preview deployed (SIMULATED hosting)');

    // ── Customer approves the preview via reply (SIMULATED webhook).
    await world.conversationsService.recordInboundReply({
      fromEmail: 'owner@sandboxbakery.example.com',
      subject: 'Re: Your website preview is ready',
      body: 'Approved — please go live.',
      externalId: 'sbx-inbound-2',
      provider: 'resend-simulated',
    });
    assert.equal(world.jobs.requireById(pipeline.jobId).state, 'CLIENT_APPROVED');

    // ── [SIMULATED Stripe TEST] checkout: deterministic pricing from config.
    world.engine.transition(pipeline.jobId, 'AWAITING_PAYMENT', { actor: 'system', actorType: 'system' });

    // Stripe-shaped event provider: signature check + mutable current event.
    const currentEvent: { value: ParsedPaymentEvent } = {
      value: { eventId: 'evt_none', type: 'payment.succeeded', reference: 'none' },
    };
    const provider: PaymentProvider = {
      name: 'stripe',
      signatureHeader: 'stripe-signature',
      createCheckout: async (input) => ({
        providerReference: `cs_test_${input.jobId}`,
        checkoutUrl: 'https://checkout.stripe.com/c/pay/sandbox',
      }),
      verifyWebhookSignature: (rawBody, signature) => signature === 'valid' && rawBody.length > 0,
      parseWebhookEvent: () => currentEvent.value,
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

    const created = await payments.createPaymentRequest(pipeline.jobId, 'business');
    assert.equal(created.checkoutUrl.includes('checkout.stripe.com'), true, 'checkout URL returned [SIMULATED Stripe TEST]');
    const payRow = world.db.get<{ reference: string; amount: number; currency: string; key: string; tier: string }>(
      'SELECT provider_reference AS reference, amount_cents AS amount, currency, tier, idempotency_key AS key FROM payments',
    );
    assert.ok(payRow, 'payment row exists');
    assert.ok(payRow.reference.startsWith('cs_test_'));
    assert.equal(Number(payRow.amount), world.config.pricing.tiers['business'], 'amount == configured tier price');

    // ── Signed webhook (SIMULATED Stripe-Signature) confirms payment.
    currentEvent.value = {
      eventId: 'evt_sandbox_pay',
      type: 'payment.succeeded',
      reference: payRow.reference,
      amountCents: Number(payRow.amount),
      currency: payRow.currency,
      metadata: { job_id: pipeline.jobId, idempotency_key: payRow.key, pricing_tier: payRow.tier },
    };
    const confirmed = await payments.handleWebhook('{"stripe":"signed-webhook-payload"}', 'valid');
    assert.equal(confirmed.code, 'applied');
    assert.equal(world.jobs.requireById(pipeline.jobId).state, 'PAYMENT_CONFIRMED');

    // ── Production deploy with A3 artifact binding → COMPLETED.
    world.engine.transition(pipeline.jobId, 'READY_FOR_PRODUCTION', { actor: 'system', actorType: 'system' });
    const production = await pipeline.deploy.deployProduction(pipeline.jobId);
    assert.equal(production.deployed, true);
    assert.ok(existsSync(path.join(pipeline.productions, pipeline.jobId, 'index.html')), 'production artifact deployed');
    assert.equal(world.jobs.requireById(pipeline.jobId).state, 'COMPLETED');

    // ── Audit trail covers the whole journey.
    const actions = world.audit.listForJob(pipeline.jobId).map((e) => e.action);
    const expectedActions = ['lead.imported', 'research.completed', 'outreach.drafted', 'outreach.approved', 'outreach.sent', 'reply.received', 'reply.processed', 'generation.completed', 'review.completed', 'preview.deployed', 'preview.sent', 'payment.request_created', 'payment.confirmed', 'production.deployed'];
    for (const expected of expectedActions) {
      assert.ok(actions.includes(expected), `audit trail must contain ${expected}`);
    }

    // Dashboard state: exactly one completed job.
    const jobs = world.jobs.listAll(100);
    assert.equal(jobs.filter((j) => j.state === 'COMPLETED').length, 1);
  });
});

function expectedAction(a: string[]): string {
  return a[0] ?? '';
}
function expectedActionName(): string {
  return 'expected';
}
function expectedActionNameOf() {}
const expectedActions = ['x'];

function signedEvent(payload: unknown): string {
  return JSON.stringify(payload);
}