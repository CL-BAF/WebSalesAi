import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConflictError } from '../domain/errors.js';

export type SqlParams = string | number | bigint | Uint8Array | null;

export class Database {
  private readonly db: DatabaseSync;
  private txDepth = 0;
  private asyncTxOpen = false;
  private asyncChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  /**
   * Synchronous transaction. Nested calls join the open tx. Async fn is a
   * programming error: it is rolled back and refused — async work must use
   * transactionAsync() so the connection's write ownership is explicit.
   * Throws ConflictError if an async transaction is currently open (another
   * flow must not interleave with it, or its writes could be trapped in the
   * async tx and lost on rollback — H4-1).
   */
  transaction<T>(fn: () => T): T {
    if (this.asyncTxOpen) {
      // Must precede the nested-join check: while an async transaction holds
      // the connection, a sync caller cannot be distinguished from the async
      // flow itself, and its writes could be trapped in the async tx (lost on
      // rollback). Async tx bodies must use plain statements, not nesting.
      throw new ConflictError('an async transaction is open on this connection; refusing to interleave a sync transaction');
    }
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    let result: unknown;
    try {
      result = fn();
    } catch (err) {
      this.rollbackQuietly();
      throw err;
    }
    if (result instanceof Promise) {
      this.rollbackQuietly();
      throw new ConflictError('transaction() is synchronous; use transactionAsync() for async work');
    }
    try {
      this.db.exec('COMMIT');
      return result as T;
    } catch (err) {
      this.rollbackQuietly();
      throw err;
    } finally {
      if (this.txDepth > 0) this.txDepth--;
    }
  }

  /**
   * Async transactions, serialized through a mutex chain so two async
   * transactions can never interleave with each other. Sync transactions
   * refuse to run while one is open. Reserved for future short-await use;
   * network I/O belongs in the transactional-outbox pattern instead.
   */
  transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0 || this.asyncTxOpen) {
      // Joining an open sync tx is meaningless for async work: the sync tx
      // would commit before the async continuations run. Refuse loudly.
      throw new ConflictError('cannot start an async transaction inside another transaction');
    }
    const run = this.asyncChain.then(() => {
      this.asyncTxOpen = true;
      this.db.exec('BEGIN IMMEDIATE');
      this.txDepth++;
      return fn().then(
        (value) => {
          this.db.exec('COMMIT');
          this.txDepth--;
          this.asyncTxOpen = false;
          return value;
        },
        (err) => {
          this.rollbackQuietly();
          this.asyncTxOpen = false;
          throw err;
        },
      );
    });
    this.asyncChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private rollbackQuietly(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // rollback of an already-aborted tx; nothing further to do
    }
    this.txDepth = Math.max(0, this.txDepth - 1);
  }

  run(sql: string, ...params: SqlParams[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.prepare(sql).run(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlParams[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlParams[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  close(): void {
    this.db.close();
  }
}
