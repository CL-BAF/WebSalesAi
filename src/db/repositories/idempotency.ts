import { nowIso } from '../../domain/ids.js';
import { AppError } from '../../domain/errors.js';
import type { Database } from '../database.js';

export class IdempotencyScopeError extends AppError {
  constructor(key: string, expected: string, actual: string) {
    super('IDEMPOTENCY_SCOPE_MISMATCH', `idempotency key ${key} was created for scope "${actual}", not "${expected}"`);
  }
}

/**
 * Generic idempotency helper for external side effects (emails, invoices,
 * deployments).
 *
 * runOnce(key, scope, fn) guarantees:
 *  - fn executes at most once per key for truly-completed runs (replays return
 *    the stored result without calling fn);
 *  - if fn THROWS, the key is released (row deleted) so the action can be
 *    retried cleanly — a failed attempt must never poison the key;
 *  - concurrent duplicate invocations while fn is still executing are
 *    rejected ("in flight") rather than double-executed.
 *
 * At-most-once safety for external effects does NOT rest on this row alone:
 * it comes from the DB unique constraints (outreach_log.idempotency_key,
 * deployments.idempotency_key, payments.idempotency_key,
 * messages(conversation_id, external_id), payment_events(provider, event_id))
 * plus provider-side idempotency keys.
 *
 * Residual crash window: if the process dies between fn's external effect and
 * this row's completion, the row remains completed_at=NULL and replays are
 * rejected as in-flight. Recovery is operator cleanup of that single row
 * (DELETE FROM idempotency_keys WHERE key = ?); the unique constraints then
 * make a retry a no-op at the DB level even if the provider would re-accept.
 */
export class IdempotencyRepository {
  constructor(private readonly db: Database) {}

  async runOnce<T>(key: string, scope: string, fn: () => T | Promise<T>): Promise<{ fresh: boolean; result: T }> {
    const at = nowIso();
    const inserted = this.db.run(
      'INSERT OR IGNORE INTO idempotency_keys (key, scope, created_at) VALUES (?, ?, ?)',
      key,
      scope,
      at,
    );
    if (Number(inserted.changes) === 1) {
      // We own the key. Execute fn INSIDE a transaction so the stored result
      // and any DB side effects commit atomically (async fn keeps the
      // transaction open across awaits). On failure, release the key so the
      // caller can retry.
      try {
        const result = (await this.db.transaction(async () => {
          const value = (await fn()) as T;
          this.db.run(
            'UPDATE idempotency_keys SET result_json = ?, completed_at = ? WHERE key = ?',
            JSON.stringify({ value: value ?? null }),
            nowIso(),
            key,
          );
          return value;
        })) as T;
        return { fresh: true, result };
      } catch (err) {
        this.db.run('DELETE FROM idempotency_keys WHERE key = ?', key);
        throw err;
      }
    }

    // Key exists: compare scope, then return the cached result for completed
    // runs or reject true concurrent execution.
    const row = this.db.get<{ result_json: string | null; completed_at: string | null; scope: string }>(
      'SELECT result_json, completed_at, scope FROM idempotency_keys WHERE key = ?',
      key,
    );
    if (!row) {
      // Raced with a failed-claim release; caller can simply retry.
      throw new AppError('IDEMPOTENCY_RETRY', `idempotency key ${key} was released concurrently; retry`);
    }
    if (row.scope !== scope) {
      throw new IdempotencyScopeError(key, scope, row.scope);
    }
    if (row.completed_at === null) {
      throw new AppError('IDEMPOTENCY_IN_FLIGHT', `idempotent action "${scope}" with key ${key} is currently in flight`);
    }
    if (row.result_json === null) {
      return { fresh: false, result: undefined as T };
    }
    const parsed = JSON.parse(row.result_json) as { value: T };
    return { fresh: false, result: parsed.value };
  }
}
