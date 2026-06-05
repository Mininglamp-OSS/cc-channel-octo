import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GroupContext } from '../group-context.js';
import { createAdapter } from '../db-adapter.js';
import type { DbAdapter } from '../db-adapter.js';

// Mock the Octo API
vi.mock('../octo/api.js', () => ({
  getGroupMembers: vi.fn().mockResolvedValue([]),
  fetchUserInfo: vi.fn().mockResolvedValue(null),
}));

import { getGroupMembers, fetchUserInfo } from '../octo/api.js';

function createTestAdapter(): DbAdapter {
  const adapter = createAdapter(':memory:');
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      name TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(group_id, uid)
    );
  `);
  return adapter;
}

describe('GroupContext', () => {
  let adapter: DbAdapter;
  let ctx: GroupContext;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createTestAdapter();
    ctx = new GroupContext(adapter, 6000);
  });

  // --- pushMessage + cache ---

  it('pushMessage adds to cache and learns member', () => {
    ctx.pushMessage('ch1', 'u1', 'Alice', 'hello', Date.now());
    expect(ctx.getName('u1', 'ch1')).toBe('Alice');
  });

  it('cache window respects maxWindowSize', () => {
    for (let i = 0; i < 110; i++) {
      ctx.pushMessage('ch1', 'u1', 'Alice', `msg-${i}`, Date.now());
    }
    const context = ctx.buildContext('ch1');
    // Should have at most 100 messages (maxWindowSize default)
    const lines = context.split('\n').filter((l) => l.startsWith('Alice'));
    expect(lines.length).toBeLessThanOrEqual(100);
  });

  // --- buildContext ---

  it('buildContext returns empty when maxContextChars is very small', () => {
    const smallCtx = new GroupContext(adapter, 5);
    smallCtx.pushMessage('ch1', 'u1', 'Alice', 'hello world', Date.now());
    const output = smallCtx.buildContext('ch1');
    // With only 5 chars budget, should return empty or at most 5 chars
    expect(output.length).toBeLessThanOrEqual(5);
  });

  it('buildContext respects maxContextChars budget', () => {
    const smallCtx = new GroupContext(adapter, 50);
    for (let i = 0; i < 10; i++) {
      smallCtx.pushMessage('ch1', 'u1', 'A', `message number ${i}`, Date.now());
    }
    const output = smallCtx.buildContext('ch1');
    // Total length should be within budget + header/trailer
    expect(output.length).toBeLessThanOrEqual(50);
  });

  it('buildContext returns empty string for empty cache', () => {
    expect(ctx.buildContext('ch1')).toBe('');
  });

  it('buildContext formats correctly', () => {
    ctx.pushMessage('ch1', 'u1', 'Alice', 'hello', 1000);
    ctx.pushMessage('ch1', 'u2', 'Bob', 'world', 2000);
    const output = ctx.buildContext('ch1');
    expect(output).toContain('[Recent group messages]');
    expect(output).toContain('Alice：hello');
    expect(output).toContain('Bob：world');
    // Alice should come before Bob (chronological)
    expect(output.indexOf('Alice')).toBeLessThan(output.indexOf('Bob'));
  });

  // --- Per-channel isolation ---

  it('memberMap is per-channel — same name different channels', () => {
    ctx.learnMember('ch1', 'uid-a', 'Alice');
    ctx.learnMember('ch2', 'uid-b', 'Alice');
    // Each channel maps "Alice" to a different uid
    expect(ctx.getName('uid-a', 'ch1')).toBe('Alice');
    expect(ctx.getName('uid-b', 'ch2')).toBe('Alice');
    // getName should NOT find uid-b in ch1
    expect(ctx.getName('uid-b', 'ch1')).toBeUndefined();
  });

  // --- learnMember rename ---

  it('learnMember removes old nameToUid entry on rename', () => {
    ctx.learnMember('ch1', 'u1', 'OldName');
    expect(ctx.resolveMentions('@OldName hello', 'ch1')).toEqual(['u1']);

    ctx.learnMember('ch1', 'u1', 'NewName');
    // Old name should no longer resolve
    expect(ctx.resolveMentions('@OldName hello', 'ch1')).toEqual([]);
    // New name should resolve
    expect(ctx.resolveMentions('@NewName hello', 'ch1')).toEqual(['u1']);
  });

  it('rename does not clobber another user with the same old display name', () => {
    // Both users start with different names
    ctx.learnMember('ch1', 'u1', 'Alice');
    ctx.learnMember('ch1', 'u2', 'Alice'); // u2 takes over 'Alice'

    // Now u2 renames — should NOT delete 'Alice' → u2 if still valid,
    // but since u2 owns 'Alice', it should be cleaned up
    ctx.learnMember('ch1', 'u2', 'Bob');
    // 'Alice' is no longer mapped to anyone (u1 was overwritten by u2,
    // u2 renamed to Bob)
    // But u1's memberMap entry still says 'Alice'
    expect(ctx.getName('u1', 'ch1')).toBe('Alice');
    expect(ctx.getName('u2', 'ch1')).toBe('Bob');
  });

  it('duplicate display name: rename does not delete mapping owned by other uid', () => {
    ctx.learnMember('ch1', 'u1', 'SharedName');
    ctx.learnMember('ch1', 'u2', 'SharedName'); // u2 takes over reverse mapping
    // Now u1 renames — should NOT delete 'SharedName' because it points to u2
    ctx.learnMember('ch1', 'u1', 'UniqueName');
    // SharedName should still resolve to u2
    expect(ctx.resolveMentions('@SharedName', 'ch1')).toEqual(['u2']);
    expect(ctx.resolveMentions('@UniqueName', 'ch1')).toEqual(['u1']);
  });

  // --- resolveMentions ---

  it('resolveMentions strips trailing punctuation', () => {
    ctx.learnMember('ch1', 'u1', 'Alice');
    expect(ctx.resolveMentions('@Alice，你好', 'ch1')).toEqual(['u1']);
    expect(ctx.resolveMentions('@Alice!', 'ch1')).toEqual(['u1']);
    expect(ctx.resolveMentions('@Alice。', 'ch1')).toEqual(['u1']);
  });

  it('resolveMentions does NOT do progressive prefix matching', () => {
    ctx.learnMember('ch1', 'u1', 'A');
    // @Alice should NOT match "A" via prefix
    expect(ctx.resolveMentions('@Alice', 'ch1')).toEqual([]);
  });

  it('resolveMentions per-channel isolation', () => {
    ctx.learnMember('ch1', 'uid-1', 'Alice');
    ctx.learnMember('ch2', 'uid-2', 'Alice');
    // ch1 resolves to uid-1
    expect(ctx.resolveMentions('@Alice', 'ch1')).toEqual(['uid-1']);
    // ch2 resolves to uid-2
    expect(ctx.resolveMentions('@Alice', 'ch2')).toEqual(['uid-2']);
  });

  it('resolveMentions returns empty for unknown names', () => {
    expect(ctx.resolveMentions('@Nobody', 'ch1')).toEqual([]);
  });

  it('resolveMentions deduplicates UIDs', () => {
    ctx.learnMember('ch1', 'u1', 'Alice');
    expect(ctx.resolveMentions('@Alice and @Alice again', 'ch1')).toEqual(['u1']);
  });

  // --- refreshMembers ---

  it('refreshMembers throttles within 1h', async () => {
    vi.mocked(getGroupMembers).mockResolvedValue([{ uid: 'u1', name: 'Alice', role: 0 }]);
    await ctx.refreshMembers('ch1', 'http://api', 'token');
    expect(getGroupMembers).toHaveBeenCalledTimes(1);

    // Second call within 1h should be skipped
    await ctx.refreshMembers('ch1', 'http://api', 'token');
    expect(getGroupMembers).toHaveBeenCalledTimes(1);
  });

  it('refreshMembers does not record lastRefresh on failure', async () => {
    vi.mocked(getGroupMembers).mockRejectedValueOnce(new Error('network'));
    await ctx.refreshMembers('ch1', 'http://api', 'token');

    // Should retry immediately since lastRefresh was not set
    vi.mocked(getGroupMembers).mockResolvedValue([{ uid: 'u1', name: 'Alice', role: 0 }]);
    await ctx.refreshMembers('ch1', 'http://api', 'token');
    expect(getGroupMembers).toHaveBeenCalledTimes(2);
    expect(ctx.getName('u1', 'ch1')).toBe('Alice');
  });

  // --- loadMembersFromDb ---

  it('loadMembersFromDb populates in-memory maps', () => {
    // Write directly to DB
    adapter.prepare(
      'INSERT INTO group_members (group_id, uid, name, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ch1', 'u1', 'Alice', Date.now());
    adapter.prepare(
      'INSERT INTO group_members (group_id, uid, name, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ch1', 'u2', 'Bob', Date.now());

    ctx.loadMembersFromDb('ch1');
    expect(ctx.getName('u1', 'ch1')).toBe('Alice');
    expect(ctx.getName('u2', 'ch1')).toBe('Bob');
    expect(ctx.resolveMentions('@Alice @Bob', 'ch1')).toEqual(['u1', 'u2']);
  });

  // --- fetchAndLearnUser ---

  it('fetchAndLearnUser caches after first lookup', async () => {
    vi.mocked(fetchUserInfo).mockResolvedValue({ uid: 'u1', name: 'Alice' });
    const name1 = await ctx.fetchAndLearnUser('u1', 'ch1', 'http://api', 'token');
    expect(name1).toBe('Alice');
    expect(fetchUserInfo).toHaveBeenCalledTimes(1);

    // Second call should return cached, no API call
    const name2 = await ctx.fetchAndLearnUser('u1', 'ch1', 'http://api', 'token');
    expect(name2).toBe('Alice');
    expect(fetchUserInfo).toHaveBeenCalledTimes(1);
  });

  // --- Q15: pushMessage persists to SQLite ---

  it('pushMessage persists messages to group_messages table', () => {
    ctx.pushMessage('ch1', 'u1', 'Alice', 'hello world', 1000);
    ctx.pushMessage('ch1', 'u2', 'Bob', 'hi there', 2000);

    const rows = adapter.prepare(
      'SELECT from_uid, from_name, content, timestamp FROM group_messages WHERE channel_id = ? ORDER BY id',
    ).all('ch1') as Array<{ from_uid: string; from_name: string; content: string; timestamp: number }>;
    expect(rows.length).toBe(2);
    expect(rows[0].from_uid).toBe('u1');
    expect(rows[0].content).toBe('hello world');
    expect(rows[1].from_uid).toBe('u2');
  });

  it('loadMessagesFromDb restores messages after fresh GroupContext creation', () => {
    // Push messages with first context
    ctx.pushMessage('ch1', 'u1', 'Alice', 'msg1', 1000);
    ctx.pushMessage('ch1', 'u2', 'Bob', 'msg2', 2000);

    // Create a fresh GroupContext with same adapter
    const ctx2 = new GroupContext(adapter, 6000);
    ctx2.loadMessagesFromDb('ch1');

    // Should restore messages and produce context
    const context = ctx2.buildContext('ch1');
    expect(context).toContain('Alice：msg1');
    expect(context).toContain('Bob：msg2');
  });

  // --- Q16: loadAllFromDb ---

  it('loadAllFromDb loads members and messages for all groups', () => {
    // Setup: push data to two different groups
    ctx.pushMessage('ch1', 'u1', 'Alice', 'hello', 1000);
    ctx.pushMessage('ch2', 'u2', 'Bob', 'world', 2000);
    ctx.learnMember('ch1', 'u1', 'Alice');
    ctx.learnMember('ch2', 'u2', 'Bob');

    // Create a fresh context and loadAllFromDb
    const ctx2 = new GroupContext(adapter, 6000);
    ctx2.loadAllFromDb();

    // Members should be restored
    expect(ctx2.getName('u1', 'ch1')).toBe('Alice');
    expect(ctx2.getName('u2', 'ch2')).toBe('Bob');

    // Messages should be restored
    const context1 = ctx2.buildContext('ch1');
    expect(context1).toContain('Alice：hello');
    const context2 = ctx2.buildContext('ch2');
    expect(context2).toContain('Bob：world');
  });
});

// ─── G23: robot flag tracking ───────────────────────────────────────────────────────────────

describe('G23: robot flag', () => {
  let adapter: DbAdapter;
  let ctx: GroupContext;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createTestAdapter();
    ctx = new GroupContext(adapter, 6000);
  });

  it('isRobot returns undefined for unknown channel/uid', () => {
    expect(ctx.isRobot('ch-unknown', 'u-unknown')).toBeUndefined();
  });

  it('refreshMembers populates robot flags from GroupMember.robot field', async () => {
    (getGroupMembers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { uid: 'alice', name: 'Alice', robot: 0 },
      { uid: 'helper_bot', name: 'Helper', robot: 1 },
      { uid: 'no-flag', name: 'NoFlag' }, // robot undefined — should NOT be stored
    ]);
    await ctx.refreshMembers('ch1', 'https://api', 'token');

    expect(ctx.isRobot('ch1', 'alice')).toBe(false);
    expect(ctx.isRobot('ch1', 'helper_bot')).toBe(true);
    expect(ctx.isRobot('ch1', 'no-flag')).toBeUndefined();
  });

  it('robot flags are scoped per channel — no cross-channel leakage', async () => {
    (getGroupMembers as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ uid: 'shared', name: 'A', robot: 1 }])
      .mockResolvedValueOnce([{ uid: 'shared', name: 'A', robot: 0 }]);
    await ctx.refreshMembers('ch1', 'https://api', 'token');
    // Force second refresh by clearing lastRefresh state — use a different channel
    await ctx.refreshMembers('ch2', 'https://api', 'token');
    expect(ctx.isRobot('ch1', 'shared')).toBe(true);
    expect(ctx.isRobot('ch2', 'shared')).toBe(false);
  });
});
