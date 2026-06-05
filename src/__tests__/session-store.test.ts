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
