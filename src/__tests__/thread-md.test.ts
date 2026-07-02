/**
 * Tests for the THREAD.md server cache + thread-branch resolver (P3-1).
 *
 * Covers:
 *   - ThreadMdCache: in-memory store/read keyed by the COMPOSITE `groupNo::shortId`,
 *     TTL expiry, invalidate, path-safe components, cross-group isolation (same
 *     shortId under different parents never collide), and no durable backing.
 *   - resolveGroupInstructions thread branch: mutual exclusion from the group
 *     GROUP.md (the core XIN-224 fix), threadMd flag gating, server-first
 *     preference, never-lose local `<shortId>.md` fallback, cache reuse, TTL
 *     re-fetch, and the invariant that the thread branch NEVER reads or writes
 *     the group GROUP.md cache / endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupMdCache, ThreadMdCache } from '../group-md-cache.js';
import { resolveGroupInstructions } from '../group-md.js';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

let cfgDir: string;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  cfgDir = mkdtempSync(join(tmpdir(), 'thread-md-cfg-'));
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function mockMd(content: string, version = 1): Response {
  return new Response(
    JSON.stringify({ content, version, updated_at: '2026-07-01T00:00:00Z', updated_by: 'op' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const BASE = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };
const GROUP = 'grp001';
const SHORT = '2071488441815666688'; // a real-shaped snowflake shortId
const CHANNEL = `${GROUP}____${SHORT}`;

/** A controllable clock for deterministic TTL tests. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function call0Url(): string {
  return (fetchMock.mock.calls[0] as [string, RequestInit])[0];
}

// ─── ThreadMdCache ─────────────────────────────────────────────────────────

describe('ThreadMdCache', () => {
  it('stores and reads an entry keyed by the composite groupNo::shortId', () => {
    const cache = new ThreadMdCache();
    cache.set(GROUP, SHORT, { content: 'hi', version: 3, updated_at: null });
    expect(cache.get(GROUP, SHORT)).toEqual({ content: 'hi', version: 3, updated_at: null, updated_by: undefined });
  });

  it('isolates the same shortId under different parent groups (composite key double-insurance)', () => {
    const cache = new ThreadMdCache();
    cache.set('groupA', SHORT, { content: 'A rules', version: 1, updated_at: null });
    cache.set('groupB', SHORT, { content: 'B rules', version: 1, updated_at: null });
    expect(cache.get('groupA', SHORT)?.content).toBe('A rules');
    expect(cache.get('groupB', SHORT)?.content).toBe('B rules');
  });

  it('expires an entry once it is older than the TTL (staleness backstop)', () => {
    const clock = fakeClock();
    const cache = new ThreadMdCache(1000, clock.now);
    cache.set(GROUP, SHORT, { content: 'x', version: 1, updated_at: null });

    clock.advance(999);
    expect(cache.get(GROUP, SHORT)?.content).toBe('x'); // still fresh

    clock.advance(1); // now exactly at TTL → expired
    expect(cache.get(GROUP, SHORT)).toBeUndefined();
  });

  it('a non-positive TTL disables expiry', () => {
    const clock = fakeClock();
    const cache = new ThreadMdCache(0, clock.now);
    cache.set(GROUP, SHORT, { content: 'x', version: 1, updated_at: null });
    clock.advance(10 * 365 * 24 * 3600 * 1000);
    expect(cache.get(GROUP, SHORT)?.content).toBe('x');
  });

  it('invalidate clears the entry', () => {
    const cache = new ThreadMdCache();
    cache.set(GROUP, SHORT, { content: 'x', version: 1, updated_at: null });
    cache.invalidate(GROUP, SHORT);
    expect(cache.get(GROUP, SHORT)).toBeUndefined();
  });

  it('rejects an unsafe groupNo or shortId (never stored)', () => {
    const cache = new ThreadMdCache();
    cache.set('../escape', SHORT, { content: 'evil', version: 1, updated_at: null });
    cache.set(GROUP, '../escape', { content: 'evil', version: 1, updated_at: null });
    expect(cache.get('../escape', SHORT)).toBeUndefined();
    expect(cache.get(GROUP, '../escape')).toBeUndefined();
  });

  it('persists nothing across instances — a fresh cache shares no state (no durable backing)', () => {
    const a = new ThreadMdCache();
    a.set(GROUP, SHORT, { content: 'durable?', version: 9, updated_at: '2026-07-01T00:00:00Z', updated_by: 'op' });
    expect(a.get(GROUP, SHORT)?.content).toBe('durable?');

    const b = new ThreadMdCache();
    expect(b.get(GROUP, SHORT)).toBeUndefined();
  });
});

// ─── resolveGroupInstructions — thread branch ────────────────────────────────

describe('resolveGroupInstructions (thread branch)', () => {
  it('threadMd OFF → reads the local <shortId>.md only, never hits the server', async () => {
    writeFileSync(join(cfgDir, `${SHORT}.md`), 'thread-local rules');
    const threadCache = new ThreadMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      threadMd: false,
      ...BASE,
      channelId: CHANNEL,
      threadCache,
    });

    expect(out).toBe('thread-local rules');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('threadMd ON but no thread cache wired → local <shortId>.md only, no server call', async () => {
    writeFileSync(join(cfgDir, `${SHORT}.md`), 'thread-local rules');
    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      threadMd: true,
      ...BASE,
      channelId: CHANNEL,
    });
    expect(out).toBe('thread-local rules');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('threadMd ON → server THREAD.md wins over the local file (server-first) and uses the thread md endpoint', async () => {
    writeFileSync(join(cfgDir, `${SHORT}.md`), 'thread-local rules');
    fetchMock.mockResolvedValueOnce(mockMd('server THREAD rules'));
    const threadCache = new ThreadMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      threadMd: true,
      ...BASE,
      channelId: CHANNEL,
      threadCache,
    });

    expect(out).toBe('server THREAD rules');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call0Url()).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/threads/${SHORT}/md`);
  });

  it('caches the server fetch — a second call serves from cache (no second fetch)', async () => {
    fetchMock.mockResolvedValueOnce(mockMd('server THREAD rules'));
    const threadCache = new ThreadMdCache();
    const args = { groupConfigDir: cfgDir, threadMd: true, ...BASE, channelId: CHANNEL, threadCache };

    expect(await resolveGroupInstructions(args)).toBe('server THREAD rules');
    expect(await resolveGroupInstructions(args)).toBe('server THREAD rules');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the cache entry expires (TTL backstop picks up edits)', async () => {
    const clock = fakeClock();
    const threadCache = new ThreadMdCache(1000, clock.now);
    const args = { groupConfigDir: cfgDir, threadMd: true, ...BASE, channelId: CHANNEL, threadCache };

    fetchMock.mockResolvedValueOnce(mockMd('old rules'));
    expect(await resolveGroupInstructions(args)).toBe('old rules');

    clock.advance(1000); // expire the cached entry
    fetchMock.mockResolvedValueOnce(mockMd('new rules'));
    expect(await resolveGroupInstructions(args)).toBe('new rules');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('server 404 → falls back to the local <shortId>.md (fallback never lost)', async () => {
    writeFileSync(join(cfgDir, `${SHORT}.md`), 'thread-local rules');
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const threadCache = new ThreadMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      threadMd: true,
      ...BASE,
      channelId: CHANNEL,
      threadCache,
    });

    expect(out).toBe('thread-local rules');
  });

  it('server reachable but empty content → local fallback', async () => {
    writeFileSync(join(cfgDir, `${SHORT}.md`), 'thread-local rules');
    fetchMock.mockResolvedValueOnce(mockMd('   '));
    const threadCache = new ThreadMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      threadMd: true,
      ...BASE,
      channelId: CHANNEL,
      threadCache,
    });

    expect(out).toBe('thread-local rules');
  });

  it('server network error → local fallback, never throws', async () => {
    writeFileSync(join(cfgDir, `${SHORT}.md`), 'thread-local rules');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const threadCache = new ThreadMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      threadMd: true,
      ...BASE,
      channelId: CHANNEL,
      threadCache,
    });

    expect(out).toBe('thread-local rules');
  });

  it('no server THREAD.md and no local file → undefined', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const threadCache = new ThreadMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      threadMd: true,
      ...BASE,
      channelId: CHANNEL,
      threadCache,
    });

    expect(out).toBeUndefined();
  });

  it('🔴 thread branch NEVER reads or writes the group GROUP.md cache (mutual exclusion)', async () => {
    // Spy on the group cache. The thread branch must not touch it — a thread's
    // instructions are its own THREAD.md, never the parent group's GROUP.md.
    const groupCache = new GroupMdCache();
    const getSpy = vi.spyOn(groupCache, 'get');
    const setSpy = vi.spyOn(groupCache, 'set');
    const threadCache = new ThreadMdCache();
    fetchMock.mockResolvedValueOnce(mockMd('server THREAD rules'));

    await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true, // group flag on…
      threadMd: true, // …thread flag on
      ...BASE,
      channelId: CHANNEL,
      cache: groupCache,
      threadCache,
    });

    expect(getSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
    // The only fetch was the thread md endpoint, not the group md endpoint.
    expect(call0Url()).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/threads/${SHORT}/md`);
  });

  it('malformed thread channelId (no shortId) → local fallback, never fetches a group-scoped path', async () => {
    fetchMock.mockResolvedValue(mockMd('should not be used'));
    const threadCache = new ThreadMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      threadMd: true,
      ...BASE,
      channelId: `${GROUP}____`, // trailing separator, empty shortId
      threadCache,
    });

    expect(out).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
