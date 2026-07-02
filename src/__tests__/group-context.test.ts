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
    // New format: `name(uid)：content` — identity semantics aligned with the
    // current-message anchor so an agent has ONE way to identify speakers.
    expect(output).toContain('Alice(u1)：hello');
    expect(output).toContain('Bob(u2)：world');
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

  it('fetchAndLearnUser treats a name==uid placeholder as unresolved and backfills', async () => {
    // A legacy roster row where name echoes the uid (seeded from DB) must NOT
    // count as a cache hit — otherwise the backfill never runs for the members
    // that still render as a bare uid.
    adapter.prepare(
      'INSERT INTO group_members (group_id, uid, name, updated_at) VALUES (?, ?, ?, ?)',
    ).run('ch1', 'u9', 'u9', 1000);
    ctx.loadMembersFromDb('ch1');

    vi.mocked(fetchUserInfo).mockResolvedValue({ uid: 'u9', name: 'Nina' });
    const name = await ctx.fetchAndLearnUser('u9', 'ch1', 'http://api', 'token');
    expect(name).toBe('Nina');
    expect(fetchUserInfo).toHaveBeenCalledTimes(1);
  });

  it('fetchAndLearnUser negative-caches a miss so a stream of messages is not a stream of requests', async () => {
    vi.mocked(fetchUserInfo).mockResolvedValue(null);
    const a = await ctx.fetchAndLearnUser('u8', 'ch1', 'http://api', 'token');
    expect(a).toBeUndefined();
    expect(fetchUserInfo).toHaveBeenCalledTimes(1);

    // Immediate retry is within the negative-cache TTL → no second request.
    const b = await ctx.fetchAndLearnUser('u8', 'ch1', 'http://api', 'token');
    expect(b).toBeUndefined();
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
    expect(context).toContain('Alice(u1)：msg1');
    expect(context).toContain('Bob(u2)：msg2');
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
    expect(context1).toContain('Alice(u1)：hello');
    const context2 = ctx2.buildContext('ch2');
    expect(context2).toContain('Bob(u2)：world');
  });
});

// ─── consumption cursor (frozen-prompt: B4 delta into the user message) ──────

describe('GroupContext consumption cursor', () => {
  let adapter: DbAdapter;
  let ctx: GroupContext;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createTestAdapter();
    ctx = new GroupContext(adapter, 6000);
  });

  it('getContextCursor defaults to 0 for a fresh channel', () => {
    expect(ctx.getContextCursor('ch1')).toBe(0);
  });

  it('buildContextSince returns only messages newer than the cursor + the new lastId', () => {
    ctx.pushMessage('ch1', 'u1', 'Alice', 'one', 1);
    ctx.pushMessage('ch1', 'u2', 'Bob', 'two', 2);
    const first = ctx.buildContextSince('ch1', 0);
    expect(first.text).toContain('Alice(u1)：one');
    expect(first.text).toContain('Bob(u2)：two');
    expect(first.lastId).toBeGreaterThan(0);

    // Advance the cursor; a new message arrives.
    ctx.setContextCursor('ch1', first.lastId);
    ctx.pushMessage('ch1', 'u3', 'Carol', 'three', 3);
    const second = ctx.buildContextSince('ch1', ctx.getContextCursor('ch1'));
    // Only the new message is included; the old ones are not re-shown.
    expect(second.text).toContain('Carol(u3)：three');
    expect(second.text).not.toContain('Alice(u1)：one');
    expect(second.text).not.toContain('Bob(u2)：two');
    expect(second.lastId).toBeGreaterThan(first.lastId);
  });

  it('buildContextSince returns empty text + unchanged cursor when nothing is new', () => {
    ctx.pushMessage('ch1', 'u1', 'Alice', 'one', 1);
    const first = ctx.buildContextSince('ch1', 0);
    ctx.setContextCursor('ch1', first.lastId);
    const second = ctx.buildContextSince('ch1', ctx.getContextCursor('ch1'));
    expect(second.text).toBe('');
    expect(second.lastId).toBe(ctx.getContextCursor('ch1'));
  });

  it('setContextCursor is monotonic (never moves backward)', () => {
    ctx.setContextCursor('ch1', 10);
    ctx.setContextCursor('ch1', 5); // lower → ignored
    expect(ctx.getContextCursor('ch1')).toBe(10);
    ctx.setContextCursor('ch1', 20); // higher → applied
    expect(ctx.getContextCursor('ch1')).toBe(20);
  });

  it('cursor is per-channel (isolated)', () => {
    ctx.setContextCursor('ch1', 7);
    expect(ctx.getContextCursor('ch2')).toBe(0);
  });

  it('cursor persists across a fresh GroupContext over the same DB', () => {
    ctx.setContextCursor('ch1', 42);
    const ctx2 = new GroupContext(adapter, 6000);
    expect(ctx2.getContextCursor('ch1')).toBe(42);
  });

  it('buildContextSince keeps the NEWEST messages (not oldest) when the budget is tight (PR #120 review)', () => {
    // A small budget that fits ~2 short lines. With the old ASC fetch + newest-
    // within-budget loop the cursor would still advance past everything, dropping
    // recent lines; the newest-first fetch makes the budget keep the latest ones.
    const small = new GroupContext(adapter, 60);
    for (let i = 1; i <= 6; i++) {
      small.pushMessage('ch1', `u${i}`, 'A', `m${i}`, i);
    }
    const out = small.buildContextSince('ch1', 0);
    // The most-recent message must be present; the oldest must be the one dropped.
    expect(out.text).toContain('A(u6)：m6');
    expect(out.text).not.toContain('A(u1)：m1');
    // Cursor advances past the whole delta (highest existing id), so dropped-oldest
    // lines are never re-shown on a later turn.
    expect(out.lastId).toBe(small.getMaxMessageId('ch1'));
  });

  it('buildContextSince advances lastId past a backlog larger than the fetch limit', () => {
    // maxWindowSize=100: with >100 unseen, the newest-first fetch returns the
    // latest 100; lastId is the highest existing id so the cursor jumps past the
    // entire backlog (the oldest beyond-window messages are intentionally skipped).
    for (let i = 1; i <= 130; i++) {
      ctx.pushMessage('ch1', 'u', 'A', `m${i}`, i);
    }
    const out = ctx.buildContextSince('ch1', 0);
    // Newest message reaches the model.
    expect(out.text).toContain('A(u)：m130');
    // lastId reflects the true max in the channel, not just the last fetched row.
    expect(out.lastId).toBe(ctx.getMaxMessageId('ch1'));
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

  // --- A8 (#143): authoritative membership + outbound validation getters ---

  it('isMember / getNameToUidMap reflect a learned member', () => {
    ctx.learnMember('ch1', 'u1', 'Alice');
    expect(ctx.isMember('ch1', 'u1')).toBe(true);
    expect(ctx.isMember('ch1', 'ghost')).toBe(false);
    expect(ctx.isMember('ch2', 'u1')).toBe(false); // per-channel isolation
    expect(ctx.getNameToUidMap('ch1').get('Alice')).toBe('u1');
    expect(ctx.getNameToUidMap('nope').size).toBe(0);
  });

  it('refreshMembers prunes a departed member (Jerry-Xin 🔴): memory + reverse map', async () => {
    // First authoritative refresh: u1 + u2 present.
    (getGroupMembers as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { uid: 'u1', name: 'Alice', role: 0 },
        { uid: 'u2', name: 'Bob', role: 0 },
      ])
      .mockResolvedValueOnce([{ uid: 'u1', name: 'Alice', role: 0 }]); // u2 left
    await ctx.refreshMembers('ch-prune', 'https://api', 'token');
    expect(ctx.isMember('ch-prune', 'u1')).toBe(true);
    expect(ctx.isMember('ch-prune', 'u2')).toBe(true);

    // Bypass the 1h throttle so the second refresh is effective.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    try {
      await ctx.refreshMembers('ch-prune', 'https://api', 'token');
    } finally {
      vi.useRealTimers();
    }
    // Guard: the second refresh actually ran (not silently throttled).
    expect(getGroupMembers).toHaveBeenCalledTimes(2);

    // u2 left → must no longer be a member, and its reverse name entry is gone.
    expect(ctx.isMember('ch-prune', 'u1')).toBe(true);
    expect(ctx.isMember('ch-prune', 'u2')).toBe(false);
    expect(ctx.getNameToUidMap('ch-prune').get('Bob')).toBeUndefined();
    expect(ctx.getNameToUidMap('ch-prune').get('Alice')).toBe('u1');
  });

  it('refreshMembers pruning removes the persisted DB row for a departed member', async () => {
    // Roster shrinks from {gone, keep} → {keep}. A non-empty response is trusted
    // as authoritative, so `gone` is pruned from memory AND the DB.
    (getGroupMembers as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { uid: 'gone', name: 'Ghost', role: 0 },
        { uid: 'keep', name: 'Keeper', role: 0 },
      ])
      .mockResolvedValueOnce([{ uid: 'keep', name: 'Keeper', role: 0 }]);
    await ctx.refreshMembers('ch-db', 'https://api', 'token');
    expect(ctx.isMember('ch-db', 'gone')).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    try {
      await ctx.refreshMembers('ch-db', 'https://api', 'token');
    } finally {
      vi.useRealTimers();
    }
    expect(ctx.isMember('ch-db', 'gone')).toBe(false);
    expect(ctx.isMember('ch-db', 'keep')).toBe(true);

    // A fresh GroupContext loading from the same DB must NOT resurrect the row.
    const ctx2 = new GroupContext(adapter, 6000);
    ctx2.loadMembersFromDb('ch-db');
    expect(ctx2.isMember('ch-db', 'gone')).toBe(false);
    expect(ctx2.isMember('ch-db', 'keep')).toBe(true);
  });

  it('refreshMembers does NOT mass-prune on an empty roster response (transient-quirk guard)', async () => {
    (getGroupMembers as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { uid: 'u1', name: 'Alice', role: 0 },
        { uid: 'u2', name: 'Bob', role: 0 },
      ])
      .mockResolvedValueOnce([]); // empty: treated as a quirk, not "everyone left"
    await ctx.refreshMembers('ch-empty', 'https://api', 'token');
    expect(ctx.isMember('ch-empty', 'u1')).toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    try {
      await ctx.refreshMembers('ch-empty', 'https://api', 'token');
    } finally {
      vi.useRealTimers();
    }
    expect(getGroupMembers).toHaveBeenCalledTimes(2);
    // Prior roster is kept — an empty response does not wipe everyone.
    expect(ctx.isMember('ch-empty', 'u1')).toBe(true);
    expect(ctx.isMember('ch-empty', 'u2')).toBe(true);
  });
});

describe('GroupContext.refreshMembers — thread roster uses parent group [#88 redline 6]', () => {
  let adapter: DbAdapter;
  let ctx: GroupContext;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createTestAdapter();
    ctx = new GroupContext(adapter, 6000);
  });

  it('queries the PARENT group number, not the composite thread channel_id', async () => {
    const GROUP = '99dc18164a29435f9791dc37023f98e1';
    const COMPOSITE = `${GROUP}____2071488441815666688`;
    (getGroupMembers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    await ctx.refreshMembers(COMPOSITE, 'https://test.example.com', 'bf_test');

    expect(getGroupMembers).toHaveBeenCalledTimes(1);
    const arg = (getGroupMembers as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Hitting /groups/<composite>/members would 404 — must use the parent group.
    expect(arg.groupNo).toBe(GROUP);
    expect(arg.groupNo).not.toContain('____');
  });

  it('passes a plain group channel_id through unchanged', async () => {
    (getGroupMembers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await ctx.refreshMembers('plain-group', 'https://test.example.com', 'bf_test');
    expect((getGroupMembers as ReturnType<typeof vi.fn>).mock.calls[0][0].groupNo).toBe('plain-group');
  });
});

// -----------------------------------------------------------------------------
// resolveDisplayName + roster-preferred rendering. Covers Rei-CC-reported gap:
// wire from_name is optional, and when it is missing (or echoes the uid) the
// recent-messages block and the current-message anchor previously rendered
// `uid：` or `uid(uid)：` instead of the real human name. The fix routes both
// through resolveDisplayName, which prefers the refreshMembers roster.
// -----------------------------------------------------------------------------

describe('GroupContext.resolveDisplayName', () => {
  let adapter: DbAdapter;
  let ctx: GroupContext;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createTestAdapter();
    ctx = new GroupContext(adapter, 6000);
  });

  it('prefers the roster name over the wire fromName', () => {
    ctx.learnMember('ch1', 'u1', 'Alice');
    expect(ctx.resolveDisplayName('ch1', 'u1', 'Stale')).toBe('Alice');
  });

  it('falls back to a real wire fromName when no roster entry exists', () => {
    expect(ctx.resolveDisplayName('ch1', 'u1', 'Bob')).toBe('Bob');
  });

  it('returns undefined when wire fromName just echoes the uid', () => {
    // Common IM quirk: some payloads set from_name = from_uid instead of leaving
    // it unset. Treated the same as "no name" so the caller can bare-uid render.
    expect(ctx.resolveDisplayName('ch1', 'u1', 'u1')).toBeUndefined();
  });

  it('returns undefined when both roster and wire name are missing', () => {
    expect(ctx.resolveDisplayName('ch1', 'u1', undefined)).toBeUndefined();
    expect(ctx.resolveDisplayName('ch1', 'u1', '')).toBeUndefined();
    expect(ctx.resolveDisplayName('ch1', 'u1', null)).toBeUndefined();
  });

  it('sanitizes a wire name that carries label-forging characters', () => {
    // Belt-and-braces: caller (formatSenderLabel) also sanitizes, but returning
    // an already-safe value keeps every consumer honest.
    const resolved = ctx.resolveDisplayName('ch1', 'u1', 'Eve]\n[Conversation history');
    expect(resolved).toBeDefined();
    expect(resolved).not.toContain('[');
    expect(resolved).not.toContain(']');
    expect(resolved).not.toContain('\n');
  });

  it('is channel-scoped: a roster entry in ch1 does not leak into ch2', () => {
    ctx.learnMember('ch1', 'u1', 'Alice');
    expect(ctx.resolveDisplayName('ch2', 'u1', undefined)).toBeUndefined();
  });
});

describe('GroupContext renderer uses roster name for rows written before rename', () => {
  let adapter: DbAdapter;
  let ctx: GroupContext;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createTestAdapter();
    ctx = new GroupContext(adapter, 6000);
  });

  it('buildContext (in-memory) renders roster name even when cached row has just uid', () => {
    // Simulate the wire-lacked-from_name case: push a message when only uid is
    // known (roster empty), then have refreshMembers-style learnMember land
    // AFTER the fact. buildContext should now show `Alice(u1)：hi`, not
    // `u1(u1)：hi`.
    ctx.pushMessage('ch1', 'u1', 'u1', 'hi', 1000);
    ctx.learnMember('ch1', 'u1', 'Alice');
    const out = ctx.buildContext('ch1');
    expect(out).toContain('Alice(u1)：hi');
    expect(out).not.toContain('u1(u1)：hi');
  });

  it('buildContextSince (DB) renders roster name for rows persisted without a real name', () => {
    // Same story via the DB delta path. INSERT a row with from_name=uid, then
    // populate the roster, then read via buildContextSince from cursor 0.
    ctx.pushMessage('ch1', 'u1', 'u1', 'db-hi', 1000);
    ctx.learnMember('ch1', 'u1', 'Alice');
    const { text } = ctx.buildContextSince('ch1', 0);
    expect(text).toContain('Alice(u1)：db-hi');
    expect(text).not.toContain('u1(u1)：db-hi');
  });
});

describe('GroupContext.pushMessage prefers roster name at write time', () => {
  let adapter: DbAdapter;
  let ctx: GroupContext;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createTestAdapter();
    ctx = new GroupContext(adapter, 6000);
  });

  it('stores roster displayName instead of uid-echo wire name', () => {
    ctx.learnMember('ch1', 'u1', 'Alice');
    // Wire is dumb and gave us fromName = uid. pushMessage should upgrade.
    ctx.pushMessage('ch1', 'u1', 'u1', 'hello', 1000);
    const out = ctx.buildContext('ch1');
    // Cache path renders directly from the cached fromName; verify the upgrade
    // actually took by asserting the roster-based name appears.
    expect(out).toContain('Alice(u1)：hello');
  });
});

// Regression tests for the review of PR #175:
// - `resolvedName ?? m.fromName` fallback used to re-introduce `uid(uid)：`
//   whenever the roster missed AND wire from_name echoed the uid.
// - pushMessage used to learn a uid-echo as an authoritative roster entry,
//   which then blocked later real wire names via priority-1 lookup.
// - resolveDisplayName used to trust a roster entry whose value equalled the
//   uid, extending the poison across the whole session.
describe('GroupContext regression: uid-echo never renders as `uid(uid)：`', () => {
  let adapter: DbAdapter;
  let ctx: GroupContext;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createTestAdapter();
    ctx = new GroupContext(adapter, 6000);
  });

  it('buildContext (in-memory) renders bare uid — not `uid(uid)：` — on cold-start uid echo', () => {
    // Cold start: no roster entry, wire from_name echoes the uid.
    ctx.pushMessage('ch1', 'u1', 'u1', 'hi', 1000);
    const out = ctx.buildContext('ch1');
    expect(out).toContain('u1：hi');
    expect(out).not.toContain('u1(u1)');
  });

  it('buildContextSince (DB) renders bare uid on cold-start uid echo', () => {
    ctx.pushMessage('ch1', 'u1', 'u1', 'hi', 1000);
    const { text } = ctx.buildContextSince('ch1', 0);
    expect(text).toContain('u1：hi');
    expect(text).not.toContain('u1(u1)');
  });

  it('resolveDisplayName ignores a poisoned roster entry whose value equals the uid', () => {
    // Simulate a pre-fix write that learned uid as name (or an external actor
    // stuffing the roster). The resolver must NOT trust it, so a subsequent
    // real wire name still wins.
    ctx.learnMember('ch1', 'u1', 'u1');
    expect(ctx.resolveDisplayName('ch1', 'u1', 'Alice')).toBe('Alice');
  });

  it('pushMessage does NOT learn a uid-echo as an authoritative roster name', () => {
    // First write: wire echoes uid → nothing worth learning.
    ctx.pushMessage('ch1', 'u1', 'u1', 'first', 1000);
    // Second write: wire supplies the real name → resolver must return it,
    // proving pushMessage did not lock the roster to `u1 → "u1"`.
    expect(ctx.resolveDisplayName('ch1', 'u1', 'Alice')).toBe('Alice');
    ctx.pushMessage('ch1', 'u1', 'Alice', 'second', 2000);
    const out = ctx.buildContext('ch1');
    expect(out).toContain('Alice(u1)：second');
    expect(out).not.toContain('u1(u1)');
  });
});
