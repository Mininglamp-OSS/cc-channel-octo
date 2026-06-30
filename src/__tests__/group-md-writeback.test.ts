/**
 * P2-C: GROUP.md write-back coordinator tests (group-md-writeback.ts).
 *
 * Covers the four XIN-201 contract obligations at the mechanism layer:
 *   - ≤10240-byte UTF-8 cap rejected LOCALLY (no server PUT) — byte, not char,
 *     counting on the boundary;
 *   - successful PUT writes the new content/version back into A's in-memory
 *     cache (so the next resolve serves what we wrote, not a stale/refetched copy);
 *   - per-groupNo serialization: concurrent write-backs to the SAME group never
 *     overlap and never lose a write (no-CAS / last-write-wins is contained
 *     within this gateway), while different groups still run concurrently;
 *   - a failed PUT leaves the cache untouched and does not wedge the lock.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GroupMdWriteback,
  GroupMdContentTooLargeError,
  MAX_GROUP_MD_CONTENT_BYTES,
  type UpdateGroupMdFn,
} from '../group-md-writeback.js';
import { GroupMdCache } from '../group-md-cache.js';

const API = 'https://api.example.com';
const TOKEN = 'bot-token';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A version-incrementing fake PUT client (server-style monotonic counter). */
function versioningUpdateFn(): { fn: UpdateGroupMdFn; calls: () => number } {
  let version = 0;
  let calls = 0;
  const fn: UpdateGroupMdFn = async () => {
    calls++;
    version++;
    return { version };
  };
  return { fn, calls: () => calls };
}

describe('GroupMdWriteback', () => {
  it('writes content back to the cache with the server-assigned version', async () => {
    const cache = new GroupMdCache();
    const { fn } = versioningUpdateFn();
    const wb = new GroupMdWriteback(cache, fn);

    const res = await wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'g1', content: 'hello' });

    expect(res).toEqual({ groupNo: 'g1', version: 1, bytes: 5 });
    expect(cache.get('g1')).toEqual({ content: 'hello', version: 1, updated_at: null });
  });

  it('passes apiUrl/botToken/groupNo/content through to the PUT client', async () => {
    const cache = new GroupMdCache();
    const fn = vi.fn<UpdateGroupMdFn>(async () => ({ version: 7 }));
    const wb = new GroupMdWriteback(cache, fn);

    await wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'g9', content: 'doc' });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: API, botToken: TOKEN, groupNo: 'g9', content: 'doc' }),
    );
  });

  it('allows content exactly at the byte limit', async () => {
    const cache = new GroupMdCache();
    const { fn, calls } = versioningUpdateFn();
    const wb = new GroupMdWriteback(cache, fn);
    const atLimit = 'a'.repeat(MAX_GROUP_MD_CONTENT_BYTES); // ASCII → 1 byte each

    const res = await wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'g1', content: atLimit });

    expect(res.bytes).toBe(MAX_GROUP_MD_CONTENT_BYTES);
    expect(calls()).toBe(1);
  });

  it('rejects content over the byte limit LOCALLY without calling the PUT client', async () => {
    const cache = new GroupMdCache();
    const { fn, calls } = versioningUpdateFn();
    const wb = new GroupMdWriteback(cache, fn);
    const tooBig = 'a'.repeat(MAX_GROUP_MD_CONTENT_BYTES + 1);

    await expect(
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'g1', content: tooBig }),
    ).rejects.toBeInstanceOf(GroupMdContentTooLargeError);

    expect(calls()).toBe(0); // never hit the server
    expect(cache.get('g1')).toBeUndefined(); // cache untouched
  });

  it('counts BYTES not characters on the limit (multi-byte UTF-8)', async () => {
    const cache = new GroupMdCache();
    const { fn, calls } = versioningUpdateFn();
    const wb = new GroupMdWriteback(cache, fn);
    // '✓' is 3 UTF-8 bytes; 3414 chars = 10242 bytes > limit, though only 3414 chars.
    const content = '✓'.repeat(3414);
    expect(content.length).toBeLessThan(MAX_GROUP_MD_CONTENT_BYTES);
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(MAX_GROUP_MD_CONTENT_BYTES);

    await expect(
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'g1', content }),
    ).rejects.toBeInstanceOf(GroupMdContentTooLargeError);
    expect(calls()).toBe(0);
  });

  it('serializes concurrent write-backs to the SAME group (no overlap, no lost write)', async () => {
    const cache = new GroupMdCache();
    let active = 0;
    let maxActive = 0;
    let version = 0;
    const order: string[] = [];
    const fn: UpdateGroupMdFn = async (p) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      order.push(p.content);
      version++;
      active--;
      return { version };
    };
    const wb = new GroupMdWriteback(cache, fn);

    await Promise.all(
      ['v1', 'v2', 'v3', 'v4', 'v5'].map((c) =>
        wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'g1', content: c }),
      ),
    );

    expect(maxActive).toBe(1); // never two in-flight for the same group
    expect(order).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']); // submission order preserved
    // Last write wins in the cache, with the final monotonic version — and every
    // write actually executed (none collapsed/lost).
    expect(cache.get('g1')).toEqual({ content: 'v5', version: 5, updated_at: null });
  });

  it('runs write-backs for DIFFERENT groups concurrently', async () => {
    const cache = new GroupMdCache();
    let active = 0;
    let maxActive = 0;
    let version = 0;
    const fn: UpdateGroupMdFn = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active--;
      version++;
      return { version };
    };
    const wb = new GroupMdWriteback(cache, fn);

    await Promise.all([
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'g1', content: 'a' }),
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'g2', content: 'b' }),
    ]);

    expect(maxActive).toBe(2); // distinct groups are not serialized against each other
  });

  it('leaves the cache untouched and does not wedge the lock when a PUT fails', async () => {
    const cache = new GroupMdCache();
    let shouldFail = true;
    let version = 0;
    const fn: UpdateGroupMdFn = async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('Octo API PUT failed (500): boom');
      }
      version++;
      return { version };
    };
    const wb = new GroupMdWriteback(cache, fn);

    await expect(
      wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'g1', content: 'first' }),
    ).rejects.toThrow(/PUT failed/);
    expect(cache.get('g1')).toBeUndefined();

    // The lock chain must keep working after a rejected op.
    const res = await wb.writeBack({ apiUrl: API, botToken: TOKEN, groupNo: 'g1', content: 'second' });
    expect(res.version).toBe(1);
    expect(cache.get('g1')).toEqual({ content: 'second', version: 1, updated_at: null });
  });
});
