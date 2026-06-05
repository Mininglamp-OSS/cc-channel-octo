import { describe, it, expect, afterEach } from 'vitest';
import { createAdapter } from '../db-adapter.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('DbAdapter', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates database file and parent directories', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'db-adapter-test-'));
    const dbPath = join(tmpDir, 'nested', 'dir', 'test.db');
    const adapter = createAdapter(dbPath);
    // Should not throw — directories created automatically
    adapter.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    adapter.close();
    // Verify file exists
    expect(existsSync(dbPath)).toBe(true);
  });

  it(':memory: adapter works without filesystem', () => {
    const adapter = createAdapter(':memory:');
    adapter.exec('CREATE TABLE t (id INTEGER, name TEXT)');
    const stmt = adapter.prepare('INSERT INTO t (id, name) VALUES (?, ?)');
    stmt.run(1, 'test');
    const select = adapter.prepare('SELECT * FROM t WHERE id = ?');
    const row = select.get(1) as { id: number; name: string };
    expect(row.id).toBe(1);
    expect(row.name).toBe('test');
    adapter.close();
  });

  it('prepare returns statement with run/get/all', () => {
    const adapter = createAdapter(':memory:');
    adapter.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');
    const insert = adapter.prepare('INSERT INTO items (val) VALUES (?)');
    const result = insert.run('hello');
    expect(result.changes).toBe(1);

    const selectAll = adapter.prepare('SELECT * FROM items');
    const rows = selectAll.all() as { id: number; val: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].val).toBe('hello');
    adapter.close();
  });

  it('transaction commits on success', () => {
    const adapter = createAdapter(':memory:');
    adapter.exec('CREATE TABLE t (id INTEGER)');
    const insert = adapter.prepare('INSERT INTO t (id) VALUES (?)');
    const tx = adapter.transaction(() => {
      insert.run(1);
      insert.run(2);
    });
    tx();
    const count = adapter.prepare('SELECT count(*) as c FROM t').get() as { c: number };
    expect(count.c).toBe(2);
    adapter.close();
  });

  it('WAL mode is enabled', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'db-adapter-wal-'));
    const dbPath = join(tmpDir, 'wal-test.db');
    const adapter = createAdapter(dbPath);
    const mode = adapter.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    adapter.close();
  });

  it('foreign keys are enabled', () => {
    const adapter = createAdapter(':memory:');
    const fk = adapter.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    adapter.close();
  });
});
