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
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // rollback of an already-aborted tx; nothing further to do
      }
      throw err;
    } finally {
      this.txDepth--;
    }
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
