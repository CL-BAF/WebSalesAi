import { nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

/**
 * Generic idempotency helper for external side effects (emails, invoices,
 * deployments). runOnce(key, scope, fn) executes fn at most once per key:
 * concurrent/duplicate invocations with the same key wait for and reuse the
 * stored result. fn must be deterministic in its side effects; its result is
 * persisted so replays never re-trigger the external action.
 */
export class IdempotencyRepository {
  constructor(private readonly db: Database) {}

  runOnce<T>(key: string, scope: string, fn: () => T): { fresh: boolean; result: T } {
    const at = nowIso();
    const inserted = this.db.run(
      'INSERT OR IGNORE INTO idempotency_keys (key, scope, created_at) VALUES (?, ?, ?)',
      key,
      scope,
      at,
    );
    if (Number(inserted.changes) === 1) {
      // We own the key. Execute fn INSIDE a transaction so the stored result
      // and any DB side effects commit atomically.
      const result = this.db.transaction(() => {
        const value = fn();
        this.db.run(
          'UPDATE idempotency_keys SET result_json = ?, completed_at = ? WHERE key = ?',
          JSON.stringify({ value: value ?? null }),
          nowIso(),
          key,
        );
        return value;
      });
      return { fresh: true, result };
    }

    // Key exists: either completed (return cached result) or in-flight (error:
    // caller must retry later). For in-flight detection, completed_at is set
    // once fn finished. In-process duplicate calls within the same tx simply
    // serialize on BEGIN IMMEDIATE.
    const row = this.db.get<{ result_json: string | null; completed_at: string | null; scope: string }>(
      'SELECT result_json, completed_at, scope FROM idempotency_keys WHERE key = ?',
      key,
    );
    if (!row) {
      throw new Error(`idempotency key vanished: ${key}`);
    }
    if (row.completed_at === null) {
      throw new Error(`idempotent action "${scope}" with key ${key} is already in flight`);
    }
    if (row.result_json === null) {
      return { fresh: false, result: undefined as T };
    }
    const parsed = JSON.parse(row.result_json) as { value: T };
    return { fresh: false, result: parsed.value };
  }
}
