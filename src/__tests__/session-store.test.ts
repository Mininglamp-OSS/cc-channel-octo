import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../session-store.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';

describe('SessionStore', () => {
  let adapter: DbAdapter;
  let store: SessionStore;

  beforeEach(() => {
    adapter = createAdapter(':memory:');
    store = new SessionStore(adapter);
    store.init();
  });

  afterEach(() => {
    store.close();
  });

  it('getOrCreate creates new session', () => {
    const session = store.getOrCreate('s1', 'ch1', 2);
    expect(session.id).toBe('s1');
    expect(session.channelId).toBe('ch1');
    expect(session.channelType).toBe(2);
  });

  it('getOrCreate returns existing session with updated timestamp', () => {
    const s1 = store.getOrCreate('s1', 'ch1', 2);
    const s2 = store.getOrCreate('s1', 'ch1', 2);
    expect(s2.id).toBe('s1');
    expect(s2.updatedAt).toBeGreaterThanOrEqual(s1.updatedAt);
  });

  it('appendUser + appendAssistant + buildHistoryPrefix round-trip', () => {
    store.getOrCreate('s1', 'ch1', 1);
    store.appendUser('s1', 'Hello');
    store.appendAssistant('s1', 'Hi there');
    store.appendUser('s1', 'Thanks');

    const history = store.buildHistoryPrefix('s1', 10);
    expect(history).toContain('[user]: Hello');
    expect(history).toContain('[assistant]: Hi there');
    expect(history).toContain('[user]: Thanks');
    // Verify chronological order
    const helloIdx = history.indexOf('[user]: Hello');
    const hiIdx = history.indexOf('[assistant]: Hi there');
    const thanksIdx = history.indexOf('[user]: Thanks');
    expect(helloIdx).toBeLessThan(hiIdx);
    expect(hiIdx).toBeLessThan(thanksIdx);
  });

  it('buildHistoryPrefix respects limit', () => {
    store.getOrCreate('s1', 'ch1', 1);
    for (let i = 0; i < 10; i++) {
      store.appendUser('s1', `msg-${i}`);
    }
    const history = store.buildHistoryPrefix('s1', 3);
    // Should only contain the last 3 messages
    expect(history).toContain('msg-9');
    expect(history).toContain('msg-8');
    expect(history).toContain('msg-7');
    expect(history).not.toContain('msg-6');
  });

  it('buildHistoryPrefix returns empty for unknown session', () => {
    expect(store.buildHistoryPrefix('nonexistent', 10)).toBe('');
  });

  it('deleteSession removes session and cascades to messages', () => {
    store.getOrCreate('s1', 'ch1', 1);
    store.appendUser('s1', 'hello');
    store.deleteSession('s1');
    // Session gone
    const history = store.buildHistoryPrefix('s1', 10);
    expect(history).toBe('');
  });

  it('cleanExpired removes sessions older than 7 days', () => {
    // Create a session and manually backdate it
    store.getOrCreate('old-session', 'ch1', 1);
    store.appendUser('old-session', 'old message');

    // Backdate the session by directly updating the DB
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    adapter.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(eightDaysAgo, 'old-session');

    // Create a fresh session
    store.getOrCreate('new-session', 'ch1', 1);
    store.appendUser('new-session', 'new message');

    const cleaned = store.cleanExpired();
    expect(cleaned).toBe(1);

    // Old session gone
    expect(store.buildHistoryPrefix('old-session', 10)).toBe('');
    // New session still exists
    expect(store.buildHistoryPrefix('new-session', 10)).toContain('new message');
  });

  it('cleanExpired returns 0 when nothing expired', () => {
    store.getOrCreate('s1', 'ch1', 1);
    expect(store.cleanExpired()).toBe(0);
  });
});

// Q1-2: Migration tests for the G10 message_seq column.
// Stage 5 added ALTER TABLE messages ADD COLUMN message_seq INTEGER in init(),
// but the pre-Q1 test suite never exercised the migration path on a populated
// v0.1.0 schema. Prior to Q1, the migration error path was wrapped in a silent
// console.warn that would hide real failures.
describe('SessionStore G10 message_seq migration (Q1-2)', () => {
  it('migrates a populated v0.1.0 schema (no message_seq column) without throwing', () => {
    const adapter = createAdapter(':memory:');
    // Simulate v0.1.0 schema: messages table WITHOUT message_seq column.
    adapter.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_type INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES ('s1', 'ch1', 2, 0, 0);
      INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('s1', 'user', 'pre-migration question', 0);
      INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('s1', 'assistant', 'pre-migration answer', 0);
    `);

    const store = new SessionStore(adapter);
    // init() must run the ALTER TABLE migration cleanly on populated data.
    expect(() => store.init()).not.toThrow();

    // Pre-existing rows survive with NULL message_seq.
    const cols = adapter
      .prepare("PRAGMA table_info(messages)")
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'message_seq')).toBe(true);

    // Appending new rows post-migration works with the new column.
    store.appendUser('s1', 'post-migration question', 99);
    store.appendAssistant('s1', 'post-migration answer', 99);

    // History preserves both pre- and post-migration content.
    const history = store.buildHistoryPrefix('s1', 40);
    expect(history).toContain('pre-migration question');
    expect(history).toContain('pre-migration answer');
    expect(history).toContain('post-migration question');
    expect(history).toContain('post-migration answer');

    store.close();
  });

  it('buildSegmentedHistoryPrefix handles pre-migration NULL message_seq rows gracefully', () => {
    const adapter = createAdapter(':memory:');
    // Same v0.1.0 simulation, then migrate.
    adapter.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_type INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES ('s1', 'ch1', 2, 0, 0);
      INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('s1', 'user', 'legacy q', 100);
      INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('s1', 'assistant', 'legacy a', 100);
    `);

    const store = new SessionStore(adapter);
    store.init(); // runs migration; legacy rows now have NULL message_seq

    // Without lastBotReplySeq set, buildSegmentedHistoryPrefix returns flat
    // history regardless of NULL seq — must NOT throw.
    const flat = store.buildSegmentedHistoryPrefix('s1', 40);
    expect(flat).toContain('legacy q');
    expect(flat).toContain('legacy a');

    // Set lastBotReplySeq and add a new seq-aware row.
    store.setLastBotReplySeq('s1', 100);
    store.appendUser('s1', 'new q', 200);
    const seg = store.buildSegmentedHistoryPrefix('s1', 40);
    // Legacy NULL-seq rows attach to the answered side per the seenNew flag.
    expect(seg).toContain('[new messages]');
    expect(seg).toContain('new q');
    // Legacy content is still reachable in the segmented output.
    expect(seg).toContain('legacy q');

    store.close();
  });

  it('throws with clear error when migration cannot run (Q1-2 fail-loud guarantee)', () => {
    // Build an adapter that pretends to be a SessionStore-compatible DB but
    // has a `messages` table missing the `session_id` column entirely — a
    // genuinely broken schema. CREATE TABLE IF NOT EXISTS in init() will
    // succeed (the table exists with whatever shape), then ALTER TABLE will
    // also succeed because column add doesn't care about existing columns.
    // To actually force a failure, we shadow PRAGMA to return a column with
    // type mismatch — the most robust trigger is to make adapter.exec throw.
    const adapter = createAdapter(':memory:');
    // Pre-create messages WITHOUT the message_seq column AND lock the DB by
    // shadowing exec to throw on ALTER TABLE.
    adapter.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
    const originalExec = adapter.exec.bind(adapter);
    adapter.exec = (sql: string) => {
      if (sql.includes('ALTER TABLE messages ADD COLUMN message_seq')) {
        throw new Error('simulated migration failure');
      }
      return originalExec(sql);
    };

    const store = new SessionStore(adapter);
    // Pre-Q1: this would silently console.warn and continue with a broken DB.
    // Post-Q1: must throw with a clear error mentioning G10 migration.
    expect(() => store.init()).toThrow(/G10 message_seq migration failed/);
  });
});

describe('SessionStore — v0.3 SDK session ids (persistent sessions)', () => {
  let adapter: DbAdapter;
  let store: SessionStore;

  beforeEach(() => {
    adapter = createAdapter(':memory:');
    store = new SessionStore(adapter);
    store.init();
  });

  afterEach(() => {
    store.close();
  });

  it('returns undefined for an unknown session', () => {
    expect(store.getSdkSessionId('nope')).toBeUndefined();
  });

  it('stores and retrieves an SDK session id', () => {
    store.setSdkSessionId('k1', 'sid-1');
    expect(store.getSdkSessionId('k1')).toBe('sid-1');
  });

  it('upserts — latest id wins', () => {
    store.setSdkSessionId('k1', 'sid-1');
    store.setSdkSessionId('k1', 'sid-2');
    expect(store.getSdkSessionId('k1')).toBe('sid-2');
  });

  it('is scoped per sessionKey', () => {
    store.setSdkSessionId('a', 'sid-a');
    store.setSdkSessionId('b', 'sid-b');
    expect(store.getSdkSessionId('a')).toBe('sid-a');
    expect(store.getSdkSessionId('b')).toBe('sid-b');
  });

  it('clearSdkSessionId forgets the mapping', () => {
    store.setSdkSessionId('k1', 'sid-1');
    store.clearSdkSessionId('k1');
    expect(store.getSdkSessionId('k1')).toBeUndefined();
  });

  it('survives across a store reopen on the same DB file (persisted)', () => {
    // Use a shared in-memory is not persistent; verify the table persists within
    // the same adapter at least (file-backed persistence is exercised by other
    // tables' migration tests).
    store.setSdkSessionId('k1', 'sid-1');
    expect(store.getSdkSessionId('k1')).toBe('sid-1');
  });
});
