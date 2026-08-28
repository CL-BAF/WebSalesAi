import { newId, nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

export interface PaymentRecord {
  id: string;
  jobId: string;
  provider: string;
  providerReference: string | null;
  amountCents: number;
  currency: string;
  tier: string;
  status: 'created' | 'paid' | 'failed' | 'canceled' | 'refunded';
  checkoutUrl: string | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentEventRecord {
  id: string;
  provider: string;
  eventId: string;
  type: string;
  paymentId: string | null;
  payloadJson: string | null;
  signatureVerified: boolean;
  receivedAt: string;
}

function rowToPayment(row: Record<string, unknown>): PaymentRecord {
  return {
    id: String(row['id']),
    jobId: String(row['job_id']),
    provider: String(row['provider']),
    providerReference: (row['provider_reference'] as string | null) ?? null,
    amountCents: Number(row['amount_cents']),
    currency: String(row['currency']),
    tier: String(row['tier']),
    status: row['status'] as PaymentRecord['status'],
    checkoutUrl: (row['checkout_url'] as string | null) ?? null,
    idempotencyKey: String(row['idempotency_key']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export class PaymentRepository {
  constructor(private readonly db: Database) {}

  /** Outbox-style claim on the UNIQUE idempotency key; re-read on conflict. */
  open(input: {
    jobId: string;
    provider: string;
    amountCents: number;
    currency: string;
    tier: string;
    idempotencyKey: string;
  }): { fresh: boolean; record: PaymentRecord } {
    const at = nowIso();
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO payments (id, job_id, provider, amount_cents, currency, tier, status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`,
      newId('pay'),
      input.jobId,
      input.provider,
      input.amountCents,
      input.currency,
      input.tier,
      input.idempotencyKey,
      at,
      at,
    );
    const record = this.requireByIdempotencyKey(input.idempotencyKey);
    return { fresh: Number(inserted.changes) === 1, record };
  }

  complete(providerIdempotencyKey: string, providerReference: string, checkoutUrl: string): void {
    this.db.run(
      "UPDATE payments SET provider_reference = ?, checkout_url = ?, updated_at = ? WHERE idempotency_key = ?",
      providerReference,
      checkoutUrl,
      nowIso(),
      providerIdempotencyKey,
    );
  }

  setStatus(id: string, status: PaymentRecord['status']): void {
    this.db.run('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
  }

  requireByIdempotencyKey(idempotencyKey: string): PaymentRecord {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM payments WHERE idempotency_key = ?', idempotencyKey);
    if (!row) throw new Error(`payment not found: ${idempotencyKey}`);
    return rowToPayment(row);
  }

  tryGetLatestForJob(jobId: string): PaymentRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM payments WHERE job_id = ? ORDER BY created_at DESC LIMIT 1',
      jobId,
    );
    return row ? rowToPayment(row) : undefined;
  }

  tryGetByProviderReference(reference: string): PaymentRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM payments WHERE provider_reference = ?',
      reference,
    );
    return row ? rowToPayment(row) : undefined;
  }

  isPaid(jobId: string): boolean {
    const row = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM payments WHERE job_id = ? AND status = 'paid'",
      jobId,
    );
    return Number(row?.c ?? 0) > 0;
  }

  /** Dedupes webhook events at the storage layer (UNIQUE provider+event_id). */
  recordEvent(input: {
    provider: string;
    eventId: string;
    type: string;
    paymentId: string | null;
    payloadJson: string;
    signatureVerified: boolean;
  }): { fresh: boolean } {
    const inserted = this.db.run(
      `INSERT OR IGNORE INTO payment_events (id, provider, event_id, type, payment_id, payload_json, signature_verified, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('pev'),
      input.provider,
      input.eventId,
      input.type,
      input.paymentId,
      input.payloadJson,
      input.signatureVerified ? 1 : 0,
      nowIso(),
    );
    return { fresh: Number(inserted.changes) === 1 };
  }

  listEventsForPayment(paymentId: string): PaymentEventRecord[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM payment_events WHERE payment_id = ? ORDER BY received_at ASC', paymentId)
      .map((row) => ({
        id: String(row['id']),
        provider: String(row['provider']),
        eventId: String(row['event_id']),
        type: String(row['type']),
        paymentId: (row['payment_id'] as string | null) ?? null,
        payloadJson: (row['payload_json'] as string | null) ?? null,
        signatureVerified: Number(row['signature_verified']) === 1,
        receivedAt: String(row['received_at']),
      }));
  }
}
