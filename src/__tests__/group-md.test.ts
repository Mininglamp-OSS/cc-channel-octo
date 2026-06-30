/**
 * Tests for the GROUP.md server cache + server-first resolver (P2-A).
 *
 * Covers:
 *   - GroupMdCache: memory + disk persistence, invalidate, path-safe groupNo.
 *   - resolveGroupInstructions: feature-flag gating, server-first preference,
 *     never-lose local-file fallback (404 / empty / no-cache), cache reuse, and
 *     thread (CommunityTopic) parent-group routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupMdCache } from '../group-md-cache.js';
import { resolveGroupInstructions } from '../group-md.js';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

let cfgDir: string;
let cacheDir: string;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  cfgDir = mkdtempSync(join(tmpdir(), 'group-md-cfg-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'group-md-cache-'));
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
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

// ─── GroupMdCache ────────────────────────────────────────────────────────────

describe('GroupMdCache', () => {
  it('stores and reads an entry from memory', () => {
    const cache = new GroupMdCache(cacheDir);
    cache.set(GROUP, { content: 'hi', version: 3, updated_at: null });
    expect(cache.get(GROUP)).toEqual({ content: 'hi', version: 3, updated_at: null, updated_by: undefined });
  });

  it('persists to disk (content + meta) and survives a new instance', () => {
    const a = new GroupMdCache(cacheDir);
    a.set(GROUP, { content: 'durable', version: 9, updated_at: '2026-06-04T00:00:00Z', updated_by: 'op' });
    expect(existsSync(join(cacheDir, `${GROUP}.md`))).toBe(true);
    expect(existsSync(join(cacheDir, `${GROUP}.meta.json`))).toBe(true);
    expect(readFileSync(join(cacheDir, `${GROUP}.md`), 'utf-8')).toBe('durable');

    // A fresh instance (cold start) reads the durable copy from disk.
    const b = new GroupMdCache(cacheDir);
    expect(b.get(GROUP)).toEqual({
      content: 'durable',
      version: 9,
      updated_at: '2026-06-04T00:00:00Z',
      updated_by: 'op',
    });
  });

  it('invalidate clears memory and disk', () => {
    const cache = new GroupMdCache(cacheDir);
    cache.set(GROUP, { content: 'x', version: 1, updated_at: null });
    cache.invalidate(GROUP);
    expect(cache.get(GROUP)).toBeUndefined();
    expect(existsSync(join(cacheDir, `${GROUP}.md`))).toBe(false);
    expect(existsSync(join(cacheDir, `${GROUP}.meta.json`))).toBe(false);
  });

  it('rejects an unsafe groupNo (no read, no write outside the dir)', () => {
    const cache = new GroupMdCache(cacheDir);
    cache.set('../escape', { content: 'evil', version: 1, updated_at: null });
    expect(cache.get('../escape')).toBeUndefined();
    expect(existsSync(join(cacheDir, '..', 'escape.md'))).toBe(false);
  });

  it('works memory-only when no cacheDir is given', () => {
    const cache = new GroupMdCache();
    cache.set(GROUP, { content: 'mem', version: 1, updated_at: null });
    expect(cache.get(GROUP)?.content).toBe('mem');
  });
});

// ─── resolveGroupInstructions ─────────────────────────────────────────────────

describe('resolveGroupInstructions', () => {
  it('flag OFF → reads the local file only, never hits the server', async () => {
    writeFileSync(join(cfgDir, `${GROUP}.md`), 'local rules');
    const cache = new GroupMdCache(cacheDir);

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
    const cache = new GroupMdCache(cacheDir);

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
    const cache = new GroupMdCache(cacheDir);
    const args = { groupConfigDir: cfgDir, serverMd: true, ...BASE, channelId: GROUP, cache };

    expect(await resolveGroupInstructions(args)).toBe('server rules');
    expect(await resolveGroupInstructions(args)).toBe('server rules');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('server 404 → falls back to the local file (fallback never lost)', async () => {
    writeFileSync(join(cfgDir, `${GROUP}.md`), 'local rules');
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const cache = new GroupMdCache(cacheDir);

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
    const cache = new GroupMdCache(cacheDir);

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
    const cache = new GroupMdCache(cacheDir);

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
    const cache = new GroupMdCache(cacheDir);

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true,
      ...BASE,
      channelId: GROUP,
      cache,
    });

    expect(out).toBeUndefined();
  });

  it('thread channelId → server fetch uses the PARENT groupNo (P1 routing preserved)', async () => {
    const channelId = `${GROUP}____tid123`;
    fetchMock.mockResolvedValueOnce(mockMd('server rules'));
    const cache = new GroupMdCache(cacheDir);

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true,
      ...BASE,
      channelId,
      cache,
    });

    expect(out).toBe('server rules');
    // URL is keyed by the parent group number, NOT the composite channelId.
    expect(call0Url()).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/md`);
  });

  it('thread channelId → local fallback still routes by the thread short-id file', async () => {
    // Thread's own short-id instruction file (loadGroupConfig new semantics).
    writeFileSync(join(cfgDir, 'tid123.md'), 'thread-local rules');
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const cache = new GroupMdCache(cacheDir);

    const out = await resolveGroupInstructions({
      groupConfigDir: cfgDir,
      serverMd: true,
      ...BASE,
      channelId: `${GROUP}____tid123`,
      cache,
    });

    expect(out).toBe('thread-local rules');
  });
});

function call0Url(): string {
  return (fetchMock.mock.calls[0] as [string, RequestInit])[0];
}
