/**
 * Tests for the GROUP.md server cache + server-first resolver (P2-A).
 *
 * Covers:
 *   - GroupMdCache: in-memory store/read, TTL expiry (staleness backstop),
 *     invalidate, path-safe groupNo, and that NOTHING is written to disk
 *     (review #172 🔴 — no durable poisoning surface).
 *   - resolveGroupInstructions: feature-flag gating, server-first preference,
 *     never-lose local-file fallback (404 / empty / network / no-cache), cache
 *     reuse, TTL-driven re-fetch, and thread parent-group routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupMdCache, DEFAULT_GROUP_MD_TTL_MS } from '../group-md-cache.js';
import { resolveGroupInstructions } from '../group-md.js';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

let cfgDir: string;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  cfgDir = mkdtempSync(join(tmpdir(), 'group-md-cfg-'));
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function mockMd(content: string, version = 1): Response {
  return new Response(
    JSON.stringify({ content, version, updated_at: '2026-06-04T00:00:00Z', updated_by: 'op' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const BASE = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };
const GROUP = 'grp001';

/** A controllable clock for deterministic TTL tests. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ─── GroupMdCache ────────────────────────────────────────────────────────────

describe('GroupMdCache', () => {
  it('stores and reads an entry from memory', () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, { content: 'hi', version: 3, updated_at: null });
    expect(cache.get(GROUP)).toEqual({ content: 'hi', version: 3, updated_at: null, updated_by: undefined });
  });

  it('expires an entry once it is older than the TTL (staleness backstop)', () => {
    const clock = fakeClock();
    const cache = new GroupMdCache(1000, clock.now);
    cache.set(GROUP, { content: 'x', version: 1, updated_at: null });

    clock.advance(999);
    expect(cache.get(GROUP)?.content).toBe('x'); // still fresh

    clock.advance(1); // now exactly at TTL → expired
    expect(cache.get(GROUP)).toBeUndefined();
  });

  it('a non-positive TTL disables expiry', () => {
    const clock = fakeClock();
    const cache = new GroupMdCache(0, clock.now);
    cache.set(GROUP, { content: 'x', version: 1, updated_at: null });
    clock.advance(10 * 365 * 24 * 3600 * 1000);
    expect(cache.get(GROUP)?.content).toBe('x');
  });

  it('invalidate clears the entry', () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, { content: 'x', version: 1, updated_at: null });
    cache.invalidate(GROUP);
    expect(cache.get(GROUP)).toBeUndefined();
  });

  it('rejects an unsafe groupNo (never stored)', () => {
    const cache = new GroupMdCache();
    cache.set('../escape', { content: 'evil', version: 1, updated_at: null });
    expect(cache.get('../escape')).toBeUndefined();
  });

  it('persists nothing across instances — a fresh cache shares no state (no durable backing)', () => {
    // Regression guard for review #172 🔴: the cache must have NO durable backing
    // (memory-only). If it persisted anywhere, a brand-new instance could read a
    // prior instance's entry — and a chat-driven Write to that backing would be a
    // trusted-prompt poisoning vector surviving restart. A fresh instance must
    // come up empty.
    const a = new GroupMdCache();
    a.set(GROUP, { content: 'durable?', version: 9, updated_at: '2026-06-04T00:00:00Z', updated_by: 'op' });
    expect(a.get(GROUP)?.content).toBe('durable?');

    const b = new GroupMdCache();
    expect(b.get(GROUP)).toBeUndefined();
  });

  it('default TTL constant is exported and positive', () => {
    expect(DEFAULT_GROUP_MD_TTL_MS).toBeGreaterThan(0);
  });
});

// ─── resolveGroupInstructions ─────────────────────────────────────────────────

describe('resolveGroupInstructions', () => {
  it('flag OFF → reads the local file only, never hits the server', async () => {
    writeFileSync(join(cfgDir, `${GROUP}.md`), 'local rules');
    const cache = new GroupMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: false,
      ...BASE,
      channelId: GROUP,
      cache,
    });

    expect(out).toBe('local rules');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flag ON but no cache wired → local file only, no server call', async () => {
    writeFileSync(join(cfgDir, `${GROUP}.md`), 'local rules');
    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true,
      ...BASE,
      channelId: GROUP,
    });
    expect(out).toBe('local rules');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flag ON → server content wins over the local file (server-first)', async () => {
    writeFileSync(join(cfgDir, `${GROUP}.md`), 'local rules');
    fetchMock.mockResolvedValueOnce(mockMd('server rules'));
    const cache = new GroupMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true,
      ...BASE,
      channelId: GROUP,
      cache,
    });

    expect(out).toBe('server rules');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call0Url()).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/md`);
  });

  it('caches the server fetch — a second call serves from cache (no second fetch)', async () => {
    fetchMock.mockResolvedValueOnce(mockMd('server rules'));
    const cache = new GroupMdCache();
    const args = { groupConfigDir: cfgDir, serverMd: true, ...BASE, channelId: GROUP, cache };

    expect(await resolveGroupInstructions(args)).toBe('server rules');
    expect(await resolveGroupInstructions(args)).toBe('server rules');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the cache entry expires (TTL backstop picks up edits)', async () => {
    const clock = fakeClock();
    const cache = new GroupMdCache(1000, clock.now);
    const args = { groupConfigDir: cfgDir, serverMd: true, ...BASE, channelId: GROUP, cache };

    fetchMock.mockResolvedValueOnce(mockMd('old rules'));
    expect(await resolveGroupInstructions(args)).toBe('old rules');

    clock.advance(1000); // expire the cached entry
    fetchMock.mockResolvedValueOnce(mockMd('new rules'));
    expect(await resolveGroupInstructions(args)).toBe('new rules');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('server 404 → falls back to the local file (fallback never lost)', async () => {
    writeFileSync(join(cfgDir, `${GROUP}.md`), 'local rules');
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const cache = new GroupMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true,
      ...BASE,
      channelId: GROUP,
      cache,
    });

    expect(out).toBe('local rules');
  });

  it('server reachable but empty content → local fallback', async () => {
    writeFileSync(join(cfgDir, `${GROUP}.md`), 'local rules');
    fetchMock.mockResolvedValueOnce(mockMd('   '));
    const cache = new GroupMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true,
      ...BASE,
      channelId: GROUP,
      cache,
    });

    expect(out).toBe('local rules');
  });

  it('server network error → local fallback, never throws', async () => {
    writeFileSync(join(cfgDir, `${GROUP}.md`), 'local rules');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const cache = new GroupMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true,
      ...BASE,
      channelId: GROUP,
      cache,
    });

    expect(out).toBe('local rules');
  });

  it('no server md and no local file → undefined', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const cache = new GroupMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true,
      ...BASE,
      channelId: GROUP,
      cache,
    });

    expect(out).toBeUndefined();
  });

  it('🔴 thread channelId + serverMd on + parent has server GROUP.md → does NOT inject the parent GROUP.md (core P3 fix)', async () => {
    // The bug (XIN-224): the old resolver collapsed a thread to its parent
    // groupNo and, with serverMd on, injected the parent's server GROUP.md.
    // After the fix a thread is mutually exclusive from its parent group.
    const channelId = `${GROUP}____tid123`;
    // Any fetch that DID happen would return parent GROUP.md — its presence in
    // the output is exactly the regression we guard against.
    fetchMock.mockResolvedValue(mockMd('parent GROUP rules'));
    const cache = new GroupMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true, // group flag on…
      // …but threadMd off → thread stays local; parent GROUP.md must never leak.
      ...BASE,
      channelId,
      cache,
    });

    expect(out).toBeUndefined(); // no thread-local file, and NO parent GROUP.md
    // The thread branch must not touch the group GROUP.md endpoint at all.
    expect(fetchMock).not.toHaveBeenCalled();
    // …and it must never read or write the parent-group cache.
    expect(cache.get(GROUP)).toBeUndefined();
  });

  it('thread channelId → local fallback routes by the thread short-id file, no server call', async () => {
    // Thread's own short-id instruction file (loadGroupConfig new semantics).
    writeFileSync(join(cfgDir, 'tid123.md'), 'thread-local rules');
    const cache = new GroupMdCache();

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true, // group flag on, but a thread ignores it
      ...BASE,
      channelId: `${GROUP}____tid123`,
      cache,
    });

    expect(out).toBe('thread-local rules');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function call0Url(): string {
  return (fetchMock.mock.calls[0] as [string, RequestInit])[0];
}
