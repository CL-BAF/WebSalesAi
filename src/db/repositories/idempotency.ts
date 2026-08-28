import { nowIso } from '../../domain/ids.js';
import { AppError } from '../../domain/errors.js';
import type { Database } from '../database.js';

export class IdempotencyScopeError extends AppError {
  constructor(key: string, expected: string, actual: string) {
    super('IDEMPOTENCY_SCOPE_MISMATCH', `idempotency key ${key} was created for scope "${actual}", not "${expected}"`);
  }
}

/**
 * Idempotency layer for external side effects (emails, invoices, deployments).
 *
 * At-most-once safety for external effects does NOT rest on these rows alone:
 * it comes from DB unique constraints (outreach_log.idempotency_key,
 * deployments.idempotency_key, payments.idempotency_key,
 * messages(conversation_id, external_id), payment_events(provider, event_id))
 * plus provider-side idempotency keys.
 *
 * For actions that await an external provider, use the TRANSACTIONAL OUTBOX
 * pattern — claim() in a short sync tx (with all guards), then perform the
 * network call with NO transaction open, then complete() in a short sync tx.
 * A crash between claim and complete leaves the key in flight; recovery is
 * operator cleanup of that single row (the unique constraints make the retry
 * a DB-level no-op even if the provider would re-accept). Never hold a
 * transaction open across network I/O: async transactions on a shared SQLite
 * connection cannot guarantee concurrency ownership.
 */
export class IdempotencyRepository {
  constructor(private readonly db: Database) {}

  /**
   * Claims a key synchronously. Returns { fresh: true } when this caller owns
   * the key, or { fresh: false, result } with the cached result when the
   * action already completed. Throws when the key is in flight (true
   * concurrency) or the scope mismatches.
   */
  claim(key: string, scope: string): { fresh: true } | { fresh: false; result: unknown } {
    const at = nowIso();
    const inserted = this.db.run(
      'INSERT OR IGNORE INTO idempotency_keys (key, scope, created_at) VALUES (?, ?, ?)',
      key,
      scope,
      at,
    );
    if (Number(inserted.changes) === 1) return { fresh: true };

    const row = this.db.get<{ result_json: string | null; completed_at: string | null; scope: string }>(
      'SELECT result_json, completed_at, scope FROM idempotency_keys WHERE key = ?',
      key,
    );
    if (!row) {
      // Raced with a failed-claim release; caller may simply retry.
      throw new AppError('IDEMPOTENCY_RETRY', `idempotency key ${key} was released concurrently; retry`);
    }
    if (row.scope !== scope) {
      throw new IdempotencyScopeError(key, scope, row.scope);
    }
    if (row.completed_at === null) {
      throw new AppError('IDEMPOTENCY_IN_FLIGHT', `idempotent action "${scope}" with key ${key} is currently in flight`);
    }
    if (row.result_json === null) return { fresh: false, result: undefined };
    return { fresh: false, result: (JSON.parse(row.result_json) as { value: unknown }).value };
  }

  /** Completes a claimed key and stores its result (call inside a sync tx). */
  complete(key: string, result: unknown): void {
    this.db.run(
      'UPDATE idempotency_keys SET result_json = ?, completed_at = ? WHERE key = ?',
      JSON.stringify({ value: result ?? null }),
      nowIso(),
      key,
    );
  }

  /** Releases a claimed key after failure so the action can be retried. */
  release(key: string): void {
    this.db.run('DELETE FROM idempotency_keys WHERE key = ?', key);
  }

  /**
   * Convenience wrapper for SHORT synchronous side effects. Do NOT use for
   * network I/O — use claim/complete/release (outbox) instead.
   */
  async runOnce<T>(key: string, scope: string, fn: () => T | Promise<T>): Promise<{ fresh: boolean; result: T }> {
    const claimResult = this.claim(key, scope);
    if (!claimResult.fresh) {
      return { fresh: false, result: claimResult.result as T };
    }
    try {
      const result = (await this.db.transactionAsync(async () => {
        const value = (await fn()) as T;
        this.complete(key, value);
        return value;
      })) as T;
      return { fresh: true, result };
    } catch (err) {
      this.release(key);
      throw err;
    }
  }
}
