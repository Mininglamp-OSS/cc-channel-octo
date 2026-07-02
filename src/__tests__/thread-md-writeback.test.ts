/**
 * P3-2: THREAD.md write-back coordinator tests (group-md-writeback.ts,
 * ThreadMdWriteback).
 *
 * The thread analogue of the P2-C GROUP.md write-back tests. Covers:
 *   - ≤10240-byte UTF-8 cap rejected LOCALLY (no server PUT), byte not char;
 *   - a successful PUT writes the new content/version into the composite-keyed
 *     THREAD.md cache (so the next resolve serves what we wrote);
 *   - the write targets the thread (groupNo + shortId), NEVER the parent group;
 *   - per-`groupNo::shortId` serialization: concurrent write-backs to the SAME
 *     thread never overlap and never lose a write, while different threads (and a
 *     same-shortId thread under a different parent group) still run concurrently;
 *   - a failed PUT leaves the cache untouched and does not wedge the lock.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ThreadMdWriteback,
  ThreadMdContentTooLargeError,
  MAX_THREAD_MD_CONTENT_BYTES,
  type UpdateThreadMdFn,
} from '../group-md-writeback.js';
import { ThreadMdCache } from '../group-md-cache.js';

const API = 'https://api.example.com';
const TOKEN = 'bot-token';
const GROUP = 'grp001';
const SHORT = '2071488441815666688';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A version-incrementing fake PUT client (server-style monotonic counter). */
function versioningUpdateFn(): { fn: UpdateThreadMdFn; calls: () => number } {
  let version = 0;
  let calls = 0;
  const fn: UpdateThreadMdFn = async () => {
    calls++;
    version++;
    return { version };
  };
  return { fn, calls: () => calls };
}

describe('ThreadMdWriteback', () => {
  it('writes content back to the composite-keyed cache with the server version', async () => {
    const cache = new ThreadMdCache();
    const { fn } = versioningUpdateFn();
    const wb = new ThreadMdWriteback(cache, fn);

    const res = await wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: 'hello' });

    expect(res).toEqual({ groupNo: GROUP, shortId: SHORT, version: 1, bytes: 5 });
    expect(cache.get(GROUP, SHORT)).toEqual({ content: 'hello', version: 1, updated_at: null });
  });

  it('passes apiUrl/botToken/groupNo/shortId/content through to the PUT client', async () => {
    const cache = new ThreadMdCache();
    const fn = vi.fn<UpdateThreadMdFn>(async () => ({ version: 7 }));
    const wb = new ThreadMdWriteback(cache, fn);

    await wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: 'doc' });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: 'doc' }),
    );
  });

  it('does NOT touch the parent group key — the write is thread-scoped', async () => {
    const cache = new ThreadMdCache();
    const { fn } = versioningUpdateFn();
    const wb = new ThreadMdWriteback(cache, fn);

    await wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: 'x' });

    // The entry lives under the composite key; a DIFFERENT thread under the same
    // parent group is unaffected (no group-level bleed).
    expect(cache.get(GROUP, SHORT)).toMatchObject({ content: 'x' });
    expect(cache.get(GROUP, 'other-thread')).toBeUndefined();
  });

  it('allows content exactly at the byte limit', async () => {
    const cache = new ThreadMdCache();
    const { fn, calls } = versioningUpdateFn();
    const wb = new ThreadMdWriteback(cache, fn);
    const atLimit = 'a'.repeat(MAX_THREAD_MD_CONTENT_BYTES);

    const res = await wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: atLimit });

    expect(res.bytes).toBe(MAX_THREAD_MD_CONTENT_BYTES);
    expect(calls()).toBe(1);
  });

  it('rejects content over the byte limit LOCALLY without calling the PUT client', async () => {
    const cache = new ThreadMdCache();
    const { fn, calls } = versioningUpdateFn();
    const wb = new ThreadMdWriteback(cache, fn);
    const tooBig = 'a'.repeat(MAX_THREAD_MD_CONTENT_BYTES + 1);

    await expect(
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: tooBig }),
    ).rejects.toBeInstanceOf(ThreadMdContentTooLargeError);

    expect(calls()).toBe(0);
    expect(cache.get(GROUP, SHORT)).toBeUndefined();
  });

  it('counts BYTES not characters on the limit (multi-byte UTF-8)', async () => {
    const cache = new ThreadMdCache();
    const { fn, calls } = versioningUpdateFn();
    const wb = new ThreadMdWriteback(cache, fn);
    const content = '✓'.repeat(3414); // 3 bytes each → 10242 bytes > limit
    expect(content.length).toBeLessThan(MAX_THREAD_MD_CONTENT_BYTES);
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(MAX_THREAD_MD_CONTENT_BYTES);

    await expect(
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content }),
    ).rejects.toBeInstanceOf(ThreadMdContentTooLargeError);
    expect(calls()).toBe(0);
  });

  it('serializes concurrent write-backs to the SAME thread (no overlap, no lost write)', async () => {
    const cache = new ThreadMdCache();
    let active = 0;
    let maxActive = 0;
    let version = 0;
    const order: string[] = [];
    const fn: UpdateThreadMdFn = async (p) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      order.push(p.content);
      version++;
      active--;
      return { version };
    };
    const wb = new ThreadMdWriteback(cache, fn);

    await Promise.all(
      ['v1', 'v2', 'v3', 'v4', 'v5'].map((c) =>
        wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: c }),
      ),
    );

    expect(maxActive).toBe(1);
    expect(order).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
    expect(cache.get(GROUP, SHORT)).toEqual({ content: 'v5', version: 5, updated_at: null });
  });

  it('runs write-backs for DIFFERENT threads concurrently (incl. same shortId under different groups)', async () => {
    const cache = new ThreadMdCache();
    let active = 0;
    let maxActive = 0;
    let version = 0;
    const fn: UpdateThreadMdFn = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active--;
      version++;
      return { version };
    };
    const wb = new ThreadMdWriteback(cache, fn);

    await Promise.all([
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: 'a' }),
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: 'other', content: 'b' }),
      // Same shortId but a DIFFERENT parent group — a distinct composite key.
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'grp002', shortId: SHORT, content: 'c' }),
    ]);

    expect(maxActive).toBe(3);
  });

  it('leaves the cache untouched and does not wedge the lock when a PUT fails', async () => {
    const cache = new ThreadMdCache();
    let shouldFail = true;
    let version = 0;
    const fn: UpdateThreadMdFn = async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('Octo API PUT failed (500): boom');
      }
      version++;
      return { version };
    };
    const wb = new ThreadMdWriteback(cache, fn);

    await expect(
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: 'first' }),
    ).rejects.toThrow(/PUT failed/);
    expect(cache.get(GROUP, SHORT)).toBeUndefined();

    const res = await wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: 'second' });
    expect(res.version).toBe(1);
    expect(cache.get(GROUP, SHORT)).toEqual({ content: 'second', version: 1, updated_at: null });
  });
});
