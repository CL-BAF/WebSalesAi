import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqlParams = string | number | bigint | Uint8Array | null;

export class Database {
  private readonly db: DatabaseSync;
  private txDepth = 0;

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
   * Runs fn inside a BEGIN IMMEDIATE transaction (serializes writers, so
   * check-then-act sequences are atomic). Nested calls join the outer tx.
   * Supports async fn: the transaction stays open across awaits and commits
   * on resolution / rolls back on rejection. NOTE: on a single shared
   * connection, interleaved async work from other flows would execute inside
   * this open transaction — call paths that hold a tx across an await must
   * be short and are expected to serialize global writes (this is relied on
   * by the outreach send path for exact rate limits).
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  transaction<T>(fn: () => T): T;
  transaction(fn: () => unknown): unknown {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    let result: unknown;
    try {
      result = fn();
    } catch (err) {
      // fn threw synchronously — release the transaction before propagating.
      this.rollbackQuietly();
      throw err;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          this.db.exec('COMMIT');
          this.txDepth--;
          return value;
        },
        (err) => {
          this.rollbackQuietly();
          throw err;
        },
      );
    }
    this.db.exec('COMMIT');
    this.txDepth--;
    return result;
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
