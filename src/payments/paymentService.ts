import { ValidationError } from '../domain/errors.js';
import type { PaymentProvider } from './paymentProvider.js';
import type { PaymentRepository } from '../db/repositories/payments.js';
import type { WorkflowJobRepository } from '../db/repositories/workflowJobs.js';
import type { IdempotencyRepository } from '../db/repositories/idempotency.js';
import type { WorkflowEngine } from '../engine/workflowEngine.js';
import type { AuditEventRepository } from '../db/repositories/auditEvents.js';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export interface PaymentServiceDeps {
  config: AppConfig;
  db: Database;
  jobs: WorkflowJobRepository;
  payments: PaymentRepository;
  idempotency: IdempotencyRepository;
  engine: WorkflowEngine;
  audit: AuditEventRepository;
  paymentProvider: PaymentProvider;
  log: Logger;
}

export interface CreatePaymentResult {
  created: boolean;
  jobId: string;
  tier: string;
  amountCents: number;
  currency: string;
  checkoutUrl: string;
}

export type WebhookResult =
  | { handled: false; duplicate: true; code: 'duplicate_event' }
  | { handled: false; reason: string; code: 'invalid_signature' | 'not_configured' | 'unknown_reference' }
  | { handled: true; jobId: string; paymentStatus: 'paid' | 'failed'; duplicate: false; code: 'applied' | 'idempotent_noop' };

/**
 * Deterministic payment stage. The AI may only REQUEST payment creation
 * (this method may only be called by owner/API code after the workflow has
 * verified explicit client purchase approval); amount/currency come from
 * configuration, never from AI; status comes ONLY from signature-verified
 * webhooks with event-level deduplication.
 */
export class PaymentService {
  readonly signatureHeader: string;

  constructor(private readonly deps: PaymentServiceDeps) {
    this.signatureHeader = deps.paymentProvider.signatureHeader;
  }

  /** Creates a checkout for a tier at the CONFIGURED price. */
  async createPaymentRequest(jobId: string, tier: string): Promise<CreatePaymentResult> {
    const job = this.deps.jobs.requireById(jobId);
    const tierName = tier.trim().toLowerCase();
    const amountCents = this.deps.config.pricing.tiers[tierName];
    if (amountCents === undefined) {
      throw new ValidationError(`unknown pricing tier "${tierName}"; configured tiers: ${Object.keys(this.deps.config.pricing.tiers).join(', ')}`);
    }

    const idempotencyKey = `payment:create:${jobId}`;
    const claim = this.deps.idempotency.claim(idempotencyKey, 'payment');
    if (!claim.fresh) {
      // Replay (state has typically advanced to AWAITING_PAYMENT): return the
      // existing checkout without creating a second payment.
      const existing = this.deps.payments.requireByIdempotencyKey(idempotencyKey);
      return {
        created: true,
        jobId,
        tier: existing.tier,
        amountCents: existing.amountCents,
        currency: existing.currency,
        checkoutUrl: existing.checkoutUrl ?? '',
      };
    }

    try {
      // M8-1: a fresh claim is valid from CLIENT_APPROVED (create) OR
      // AWAITING_PAYMENT (resume after a provider failure). Any other state
      // is refused and the claim released so the caller can retry later.
      if (job.state !== 'CLIENT_APPROVED' && job.state !== 'AWAITING_PAYMENT') {
        throw new ValidationError(`payment request requires CLIENT_APPROVED state, job is ${job.state}`);
      }
      if (job.state === 'CLIENT_APPROVED') {
        this.deps.engine.transition(jobId, 'AWAITING_PAYMENT', { actor: 'system', actorType: 'system', reason: `payment request created for tier ${tierName}` });
      }

      const record = this.deps.db.transaction(() => {
        const opened = this.deps.payments.open({
          jobId,
          provider: this.deps.paymentProvider.name,
          amountCents,
          currency: this.deps.config.pricing.currency,
          tier: tierName,
          idempotencyKey,
        });
        this.deps.audit.append({
          actor: 'system',
          actorType: 'system',
          action: 'payment.request_created',
          jobId,
          leadId: job.leadId,
          details: { tier: tierName, amountCents, currency: this.deps.config.pricing.currency, fresh: opened.fresh },
        });
        return opened.record;
      });
      void record;

      const session = await this.deps.paymentProvider.createCheckout({
        jobId,
        tier: tierName,
        amountCents,
        currency: this.deps.config.pricing.currency,
        description: `Website package (${tierName}) for job ${jobId}`,
        idempotencyKey,
        successUrl: `${this.deps.config.publicBaseUrl.replace(/\/+$/, '')}/payment/success/${jobId}`,
      });

      this.deps.db.transaction(() => {
        this.deps.payments.complete(idempotencyKey, session.providerReference, session.checkoutUrl);
        this.deps.idempotency.complete(idempotencyKey, { checkoutUrl: session.checkoutUrl });
      });

      return { created: true, jobId, tier: tierName, amountCents, currency: this.deps.config.pricing.currency, checkoutUrl: session.checkoutUrl };
    } catch (err) {
      this.deps.idempotency.release(idempotencyKey);
      throw err;
    }
  }

  /** Handles a signature-verified webhook; state transitions use provider actor. */
  async handleWebhook(rawBody: string, signature: string): Promise<WebhookResult> {
    const secret = this.deps.config.paymentWebhookSecret;
    if (!secret) {
      this.deps.audit.append({ actor: 'provider', actorType: 'provider', action: 'webhook.rejected', details: { reason: 'no webhook secret configured (fail-closed)' } });
      return { handled: false, reason: 'webhook secret not configured', code: 'not_configured' };
    }
    if (!this.deps.paymentProvider.verifyWebhookSignature(rawBody, signature, secret)) {
      this.deps.audit.append({ actor: 'provider', actorType: 'provider', action: 'webhook.rejected', details: { reason: 'invalid signature' } });
      return { handled: false, reason: 'invalid signature', code: 'invalid_signature' };
    }

    const event = this.deps.paymentProvider.parseWebhookEvent(rawBody);
    const payment = this.deps.payments.tryGetByProviderReference(event.reference);

    // Event-level deduplication (UNIQUE provider+event_id) in its own tx.
    const dedupe = this.deps.db.transaction(() =>
      this.deps.payments.recordEvent({
        provider: this.deps.paymentProvider.name,
        eventId: event.eventId,
        type: event.type,
        paymentId: payment?.id ?? null,
        payloadJson: rawBody.slice(0, 20_000),
        signatureVerified: true,
      }),
    );
    if (!dedupe.fresh) {
      this.deps.audit.append({ actor: 'provider', actorType: 'provider', action: 'webhook.received', details: { eventId: event.eventId, note: 'duplicate event ignored' } });
      return { handled: false, duplicate: true, code: 'duplicate_event' };
    }

    if (!payment) {
      this.deps.audit.append({ actor: 'provider', actorType: 'provider', action: 'webhook.received', details: { eventId: event.eventId, note: 'unknown payment reference' } });
      return { handled: false, reason: 'unknown payment reference', code: 'unknown_reference' };
    }

    // Link the stored event to the payment and apply status deterministically.
    if (event.type === 'payment.succeeded') {
      // M8-2: idempotent no-op if already paid/confirmed â€” a duplicate success
      // under a fresh event id must never re-transition or throw.
      if (payment.status === 'paid') {
        this.deps.audit.append({
          actor: 'payment-provider',
          actorType: 'provider',
          action: 'webhook.received',
          details: { eventId: event.eventId, note: 'duplicate success ignored (payment already paid)' },
        });
        return { handled: true, jobId: payment.jobId, paymentStatus: 'paid', duplicate: false, code: 'idempotent_noop' };
      }
      this.deps.db.transaction(() => {
        this.deps.payments.setStatus(payment.id, 'paid');
        this.deps.audit.append({
          actor: 'payment-provider',
          actorType: 'provider',
          action: 'payment.confirmed',
          jobId: payment.jobId,
          details: { eventId: event.eventId, reference: event.reference, amountCents: payment.amountCents, currency: payment.currency },
        });
      });
      // Provider actor is the only non-owner type allowed to confirm payment.
      const current = this.deps.jobs.requireById(payment.jobId);
      if (current.state === 'AWAITING_PAYMENT') {
        this.deps.engine.transition(payment.jobId, 'PAYMENT_CONFIRMED', { actor: 'payment-provider', actorType: 'provider', reason: `webhook ${event.eventId}` });
      }
      return { handled: true, jobId: payment.jobId, paymentStatus: 'paid', duplicate: false, code: 'applied' };
    }

    // M8-2: never downgrade â€” a stale payment.failed under a fresh event id
    // must not flip an already-paid payment (the production guard reads this).
    if (payment.status === 'paid') {
      this.deps.audit.append({
        actor: 'payment-provider',
        actorType: 'provider',
        action: 'webhook.received',
        details: { eventId: event.eventId, note: 'stale failed event ignored (payment already paid)' },
      });
      return { handled: true, jobId: payment.jobId, paymentStatus: 'paid', duplicate: false, code: 'idempotent_noop' };
    }
    this.deps.db.transaction(() => {
      this.deps.payments.setStatus(payment.id, 'failed');
      this.deps.audit.append({
        actor: 'payment-provider',
        actorType: 'provider',
        action: 'payment.failed',
        jobId: payment.jobId,
        details: { eventId: event.eventId, reference: event.reference },
      });
    });
    return { handled: true, jobId: payment.jobId, paymentStatus: 'failed', duplicate: false, code: 'applied' };
  }

  /** Used by the production deployment guard (defense in depth). */
  isPaymentConfirmed(jobId: string): boolean {
    return this.deps.payments.isPaid(jobId);
  }
}


