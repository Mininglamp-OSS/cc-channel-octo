/**
 * SQLite adapter interface — thin abstraction over better-sqlite3 API.
 * Enables future migration to node:sqlite when it reaches GA.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DbAdapter {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  close(): void;
  readonly inTransaction: boolean;
  transaction<T>(fn: () => T): () => T;
}

class BetterSqliteAdapter implements DbAdapter {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]): RunResult => {
        const result = stmt.run(...(params as never[]));
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      },
      get: (...params: unknown[]): unknown => stmt.get(...(params as never[])),
      all: (...params: unknown[]): unknown[] => stmt.all(...(params as never[])),
    };
  }

  close(): void {
    this.db.close();
  }

  get inTransaction(): boolean {
    return this.db.inTransaction;
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }
}

export function createAdapter(dbPath: string): DbAdapter {
  return new BetterSqliteAdapter(dbPath);
}
