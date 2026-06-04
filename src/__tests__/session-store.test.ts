/**
 * Session Store tests.
 *
 * Coverage:
 *  - CRUD round-trip (getOrCreate, append, buildHistoryPrefix, deleteSession)
 *  - History window truncation (40 messages default, custom limit)
 *  - Expired session cleanup (7-day threshold, CASCADE delete of messages)
 *  - DbAdapter interface contract (exec, prepare, close, transaction)
 *  - Edge cases (empty history, message ordering, constraint enforcement)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createAdapter, type DbAdapter } from "../db-adapter.js";
import { SessionStore } from "../session-store.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

let tmpDir: string;
let adapter: DbAdapter;
let store: SessionStore;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "cc-octo-test-"));
  adapter = createAdapter(join(tmpDir, "test.db"));
  store = new SessionStore(adapter);
  store.init();
}

function teardown() {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(tmpDir, { recursive: true, force: true });
}

// ─── 1. CRUD Round-Trip ─────────────────────────────────────────────────────

describe("SessionStore CRUD", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("getOrCreate creates a new session", () => {
    const session = store.getOrCreate("s1", "ch1", 1);
    expect(session.id).toBe("s1");
    expect(session.channelId).toBe("ch1");
    expect(session.channelType).toBe(1);
    expect(session.createdAt).toBeGreaterThan(0);
    expect(session.updatedAt).toBeGreaterThanOrEqual(session.createdAt);
  });

  it("getOrCreate returns existing session and touches updatedAt", () => {
    store.getOrCreate("s1", "ch1", 1);

    // Backdate updated_at so we can detect the touch
    const oldTime = Date.now() - 60_000;
    adapter.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(oldTime, "s1");

    store.getOrCreate("s1", "ch1", 1);

    // Read updated_at directly — not through getOrCreate which itself touches
    const row = adapter.prepare("SELECT updated_at FROM sessions WHERE id = ?").get("s1") as { updated_at: number };
    expect(row.updated_at).toBeGreaterThan(oldTime);
  });

  it("appendUser + appendAssistant stores messages", () => {
    store.getOrCreate("s1", "ch1", 1);
    store.appendUser("s1", "hello");
    store.appendAssistant("s1", "hi there");

    const history = store.buildHistoryPrefix("s1", 40);
    expect(history).toContain("[user]: hello");
    expect(history).toContain("[assistant]: hi there");
  });

  it("buildHistoryPrefix returns messages in chronological order", () => {
    store.getOrCreate("s1", "ch1", 1);
    store.appendUser("s1", "msg1");
    store.appendAssistant("s1", "msg2");
    store.appendUser("s1", "msg3");

    const history = store.buildHistoryPrefix("s1", 40);
    const lines = history.split("\n");
    expect(lines[0]).toBe("[user]: msg1");
    expect(lines[1]).toBe("[assistant]: msg2");
    expect(lines[2]).toBe("[user]: msg3");
  });

  it("deleteSession removes session and its messages (CASCADE)", () => {
    store.getOrCreate("s1", "ch1", 1);
    store.appendUser("s1", "hello");
    store.appendAssistant("s1", "hi");

    store.deleteSession("s1");

    // History should be empty after deletion
    const history = store.buildHistoryPrefix("s1", 40);
    expect(history).toBe("");
  });

  it("deleteSession on nonexistent session does not throw", () => {
    expect(() => store.deleteSession("nonexistent")).not.toThrow();
  });

  it("multiple sessions are independent", () => {
    store.getOrCreate("s1", "ch1", 1);
    store.getOrCreate("s2", "ch2", 2);

    store.appendUser("s1", "s1-msg");
    store.appendUser("s2", "s2-msg");

    const h1 = store.buildHistoryPrefix("s1", 40);
    const h2 = store.buildHistoryPrefix("s2", 40);

    expect(h1).toBe("[user]: s1-msg");
    expect(h2).toBe("[user]: s2-msg");
    expect(h1).not.toContain("s2-msg");
    expect(h2).not.toContain("s1-msg");
  });
});

// ─── 2. History Window Truncation ───────────────────────────────────────────

describe("History window truncation", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("limit=40 returns most recent 40 messages", () => {
    store.getOrCreate("s1", "ch1", 1);
    for (let i = 0; i < 50; i++) {
      store.appendUser("s1", `msg-${i}`);
    }

    const history = store.buildHistoryPrefix("s1", 40);
    const lines = history.split("\n");
    expect(lines.length).toBe(40);
    // Should contain most recent 40 messages (msg-10 through msg-49)
    expect(lines[0]).toBe("[user]: msg-10");
    expect(lines[39]).toBe("[user]: msg-49");
  });

  it("custom limit works", () => {
    store.getOrCreate("s1", "ch1", 1);
    for (let i = 0; i < 20; i++) {
      store.appendUser("s1", `msg-${i}`);
    }

    const history = store.buildHistoryPrefix("s1", 5);
    const lines = history.split("\n");
    expect(lines.length).toBe(5);
    // Most recent 5: msg-15 through msg-19
    expect(lines[0]).toBe("[user]: msg-15");
    expect(lines[4]).toBe("[user]: msg-19");
  });

  it("returns all messages when fewer than limit", () => {
    store.getOrCreate("s1", "ch1", 1);
    store.appendUser("s1", "only-one");

    const history = store.buildHistoryPrefix("s1", 40);
    const lines = history.split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe("[user]: only-one");
  });

  it("empty history returns empty string", () => {
    store.getOrCreate("s1", "ch1", 1);
    const history = store.buildHistoryPrefix("s1", 40);
    expect(history).toBe("");
  });

  it("history for nonexistent session returns empty string", () => {
    const history = store.buildHistoryPrefix("nonexistent", 40);
    expect(history).toBe("");
  });
});

// ─── 3. Expired Session Cleanup ─────────────────────────────────────────────

describe("Expired session cleanup", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("cleanExpired removes sessions older than 7 days", () => {
    // Create a session and manually backdate its updated_at
    store.getOrCreate("old-session", "ch1", 1);
    store.appendUser("old-session", "old message");

    // Backdate: set updated_at to 8 days ago
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    adapter.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      eightDaysAgo,
      "old-session",
    );

    // Create a fresh session
    store.getOrCreate("fresh-session", "ch2", 1);
    store.appendUser("fresh-session", "fresh message");

    const cleaned = store.cleanExpired();
    expect(cleaned).toBe(1);

    // Old session's messages should be gone (CASCADE)
    const oldHistory = store.buildHistoryPrefix("old-session", 40);
    expect(oldHistory).toBe("");

    // Fresh session should still exist
    const freshHistory = store.buildHistoryPrefix("fresh-session", 40);
    expect(freshHistory).toBe("[user]: fresh message");
  });

  it("cleanExpired returns 0 when nothing to clean", () => {
    store.getOrCreate("s1", "ch1", 1);
    const cleaned = store.cleanExpired();
    expect(cleaned).toBe(0);
  });

  it("cleanExpired handles multiple expired sessions", () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const updateStmt = adapter.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");

    for (let i = 0; i < 5; i++) {
      store.getOrCreate(`expired-${i}`, "ch1", 1);
      store.appendUser(`expired-${i}`, `msg-${i}`);
      updateStmt.run(tenDaysAgo, `expired-${i}`);
    }

    // Add 2 fresh sessions
    store.getOrCreate("fresh-1", "ch1", 1);
    store.getOrCreate("fresh-2", "ch1", 1);

    const cleaned = store.cleanExpired();
    expect(cleaned).toBe(5);

    // Verify fresh sessions still have data
    const s = store.getOrCreate("fresh-1", "ch1", 1);
    expect(s.id).toBe("fresh-1");
  });

  it("CASCADE deletes messages when session is cleaned", () => {
    store.getOrCreate("s1", "ch1", 1);
    for (let i = 0; i < 10; i++) {
      store.appendUser("s1", `msg-${i}`);
    }

    // Backdate
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    adapter.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(eightDaysAgo, "s1");

    store.cleanExpired();

    // Verify messages are gone by querying directly
    const rows = adapter
      .prepare("SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?")
      .get("s1") as { cnt: number };
    expect(rows.cnt).toBe(0);
  });

  it("session just under 7 days is NOT cleaned (boundary)", () => {
    store.getOrCreate("boundary", "ch1", 1);

    // Set updated_at to exactly 7 days minus 1 second
    const justUnder = Date.now() - (7 * 24 * 60 * 60 * 1000 - 1000);
    adapter.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(justUnder, "boundary");

    const cleaned = store.cleanExpired();
    expect(cleaned).toBe(0);
  });
});

// ─── 4. DbAdapter Interface Contract ───────────────────────────────────────

describe("DbAdapter interface contract", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("exec runs raw SQL", () => {
    adapter.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY, val TEXT)");
    adapter.prepare("INSERT INTO test_table (val) VALUES (?)").run("hello");
    const row = adapter.prepare("SELECT val FROM test_table WHERE id = 1").get() as {
      val: string;
    };
    expect(row.val).toBe("hello");
  });

  it("prepare returns PreparedStatement with run/get/all", () => {
    adapter.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");

    const insert = adapter.prepare("INSERT INTO kv (k, v) VALUES (?, ?)");
    const result = insert.run("key1", "val1");
    expect(result.changes).toBe(1);

    const get = adapter.prepare("SELECT v FROM kv WHERE k = ?");
    const row = get.get("key1") as { v: string };
    expect(row.v).toBe("val1");

    insert.run("key2", "val2");
    insert.run("key3", "val3");

    const all = adapter.prepare("SELECT k FROM kv ORDER BY k");
    const rows = all.all() as { k: string }[];
    expect(rows.map((r) => r.k)).toEqual(["key1", "key2", "key3"]);
  });

  it("RunResult.lastInsertRowid returns the inserted row id", () => {
    adapter.exec("CREATE TABLE auto (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)");
    const stmt = adapter.prepare("INSERT INTO auto (val) VALUES (?)");

    const r1 = stmt.run("a");
    const r2 = stmt.run("b");
    const r3 = stmt.run("c");

    expect(Number(r1.lastInsertRowid)).toBe(1);
    expect(Number(r2.lastInsertRowid)).toBe(2);
    expect(Number(r3.lastInsertRowid)).toBe(3);
  });

  it("get returns undefined for no match", () => {
    adapter.exec("CREATE TABLE empty (id INTEGER PRIMARY KEY)");
    const row = adapter.prepare("SELECT * FROM empty WHERE id = 999").get();
    expect(row).toBeUndefined();
  });

  it("all returns empty array for no matches", () => {
    adapter.exec("CREATE TABLE empty2 (id INTEGER PRIMARY KEY)");
    const rows = adapter.prepare("SELECT * FROM empty2").all();
    expect(rows).toEqual([]);
  });

  it("WAL mode is enabled", () => {
    const row = adapter.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
  });

  it("foreign keys are enabled", () => {
    const row = adapter.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it("close prevents further operations", () => {
    adapter.close();
    expect(() => adapter.exec("SELECT 1")).toThrow();
  });

  it("transaction wraps operations atomically", () => {
    adapter.exec("CREATE TABLE txn_test (id INTEGER PRIMARY KEY, val TEXT)");
    const insert = adapter.prepare("INSERT INTO txn_test (val) VALUES (?)");

    const doInserts = adapter.transaction(() => {
      insert.run("a");
      insert.run("b");
      insert.run("c");
    });
    doInserts();

    const rows = adapter.prepare("SELECT COUNT(*) as cnt FROM txn_test").get() as { cnt: number };
    expect(rows.cnt).toBe(3);
  });

  it("transaction rolls back on exception", () => {
    adapter.exec("CREATE TABLE txn_rollback (id INTEGER PRIMARY KEY, val TEXT)");
    const insert = adapter.prepare("INSERT INTO txn_rollback (val) VALUES (?)");

    const doFailing = adapter.transaction(() => {
      insert.run("a");
      insert.run("b");
      throw new Error("intentional rollback");
    });

    expect(() => doFailing()).toThrow("intentional rollback");

    // Both inserts should be rolled back
    const rows = adapter.prepare("SELECT COUNT(*) as cnt FROM txn_rollback").get() as { cnt: number };
    expect(rows.cnt).toBe(0);
  });
});

// ─── 5. Edge Cases ──────────────────────────────────────────────────────────

describe("Edge cases", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("messages with special characters round-trip", () => {
    store.getOrCreate("s1", "ch1", 1);
    const specialContent = '中文消息 🎉\n"quotes"\t\ttabs\\backslash';
    store.appendUser("s1", specialContent);

    const history = store.buildHistoryPrefix("s1", 40);
    expect(history).toBe(`[user]: ${specialContent}`);
  });

  it("very long messages round-trip", () => {
    store.getOrCreate("s1", "ch1", 1);
    const longMsg = "x".repeat(100_000);
    store.appendUser("s1", longMsg);

    const history = store.buildHistoryPrefix("s1", 40);
    expect(history).toBe(`[user]: ${longMsg}`);
  });

  it("append touches session updatedAt", () => {
    store.getOrCreate("s1", "ch1", 1);

    // Backdate updated_at so we can detect the touch from append
    const oldTime = Date.now() - 60_000;
    adapter.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(oldTime, "s1");

    store.appendUser("s1", "new msg");

    // Read updated_at directly — not through getOrCreate which itself touches
    const row = adapter.prepare("SELECT updated_at FROM sessions WHERE id = ?").get("s1") as { updated_at: number };
    expect(row.updated_at).toBeGreaterThan(oldTime);
  });

  it("message role constraint rejects invalid roles", () => {
    store.getOrCreate("s1", "ch1", 1);
    const stmt = adapter.prepare(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
    );
    expect(() => stmt.run("s1", "system", "test", Date.now())).toThrow();
  });

  it("foreign key constraint prevents orphan messages", () => {
    const stmt = adapter.prepare(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
    );
    expect(() => stmt.run("nonexistent-session", "user", "test", Date.now())).toThrow();
  });

  it("AUTOINCREMENT guarantees ordering even with deletions", () => {
    store.getOrCreate("s1", "ch1", 1);
    store.appendUser("s1", "msg-1");
    store.appendUser("s1", "msg-2");
    store.appendUser("s1", "msg-3");

    // Delete middle message directly
    adapter.exec("DELETE FROM messages WHERE content = 'msg-2'");

    store.appendUser("s1", "msg-4");

    const history = store.buildHistoryPrefix("s1", 40);
    const lines = history.split("\n");
    expect(lines).toEqual([
      "[user]: msg-1",
      "[user]: msg-3",
      "[user]: msg-4",
    ]);
  });

  it("init is idempotent (can be called twice)", () => {
    // init() was already called in setup
    expect(() => store.init()).not.toThrow();

    // Verify it still works
    store.getOrCreate("s1", "ch1", 1);
    store.appendUser("s1", "test");
    expect(store.buildHistoryPrefix("s1", 40)).toBe("[user]: test");
  });
});
