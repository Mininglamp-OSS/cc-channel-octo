/**
 * GROUP.md write-back (P2-C): the app-layer coordinator that persists an
 * agent-authored GROUP.md back to the server (PUT /v1/bot/groups/{groupNo}/md)
 * via A's `updateGroupMd` client, then refreshes A's in-memory cache so the next
 * resolve does not TTL-refetch a stale copy.
 *
 * Two server-contract facts (XIN-201, measured — NOT inferred) shape this:
 *
 *   1. content has a HARD ≤10240-byte (UTF-8) limit; the server answers an
 *      oversized body with 400 err.server.bot_api.content_too_large. We reject
 *      locally BEFORE the PUT so a too-large write never reaches the server.
 *
 *   2. `version` is a server-side monotonic counter and the PUT does NOT do
 *      compare-and-swap (last-write-wins, no CAS). Concurrent writers therefore
 *      silently clobber each other server-side. We cannot fix a foreign writer
 *      (operator console, another gateway), but we CAN guarantee that this
 *      gateway never races itself: all write-backs for the same groupNo are
 *      serialized through a per-groupNo promise-chain lock, so the read-modify-
 *      write (PUT + cache update) for one call completes before the next starts.
 *      Cross-source last-write-wins remains possible by design — see the caveat
 *      on {@link GroupMdWriteback}.
 *
 * Owner-gating lives in the MCP tool layer (group-md-tool.ts), not here: this
 * module is the mechanism, the tool is the policy boundary.
 *
 * Never persists anything to disk — the cache it updates is the same in-memory-
 * only cache A's resolver reads (group-md-cache.ts), so this introduces no new
 * durable-trust surface.
 */

import { updateGroupMd } from './octo/api.js';
import type { GroupMdCache } from './group-md-cache.js';

/**
 * Hard UTF-8 byte ceiling for GROUP.md content, per the XIN-201 measured
 * server contract. A body above this is rejected locally (a server PUT would
 * answer 400 err.server.bot_api.content_too_large).
 */
export const MAX_GROUP_MD_CONTENT_BYTES = 10240;

/** Thrown when content exceeds {@link MAX_GROUP_MD_CONTENT_BYTES}. */
export class GroupMdContentTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(
      `GROUP.md content is ${bytes} bytes, over the ${MAX_GROUP_MD_CONTENT_BYTES}-byte UTF-8 limit`,
    );
    this.name = 'GroupMdContentTooLargeError';
  }
}

/** The `updateGroupMd` client signature, injectable for testing. */
export type UpdateGroupMdFn = typeof updateGroupMd;

/** Outcome of a successful write-back. */
export interface GroupMdWriteResult {
  groupNo: string;
  /** Server-assigned version after the PUT. */
  version: number;
  /** UTF-8 byte length of the content that was written. */
  bytes: number;
}

export interface GroupMdWriteParams {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  content: string;
  signal?: AbortSignal;
}

/**
 * Serializes GROUP.md write-backs per groupNo and keeps A's cache in sync.
 *
 * Constructed ONCE per bot (alongside the GroupMdCache it updates) and shared
 * across turns, so the per-groupNo lock actually spans concurrent agent turns —
 * a per-turn instance would defeat the lock. The MCP tool server (built per
 * turn) borrows this shared instance.
 *
 * CAVEAT (documented per XIN-201 item 4): the lock only covers THIS gateway. A
 * write from another source (operator console, a second gateway process) is not
 * coordinated and, because the server has no CAS, last-write-wins across sources
 * — that is an accepted limitation, not a bug.
 */
export class GroupMdWriteback {
  /** Tail of the in-flight write chain per groupNo (serializes same-key writes). */
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cache: GroupMdCache,
    /** Injectable PUT client (defaults to the real octo client). */
    private readonly updateFn: UpdateGroupMdFn = updateGroupMd,
  ) {}

  /**
   * Run `fn` after every previously-queued op for `key` has settled, so bodies
   * for the same key never overlap. Different keys run independently. `fn`'s
   * rejection is surfaced to its own caller; the chain tail swallows it so a
   * failed write does not wedge later writes.
   */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn); // run regardless of prior success/failure
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    // Best-effort cleanup: drop the key once the queue drains to this tail, so
    // the Map does not grow without bound across many groups.
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /**
   * Persist `content` as the group's GROUP.md and refresh the cache.
   *
   * Rejects with {@link GroupMdContentTooLargeError} (before any server call)
   * when content exceeds the UTF-8 byte limit; propagates the client error when
   * the PUT itself fails (cache is left untouched in that case).
   */
  async writeBack(params: GroupMdWriteParams): Promise<GroupMdWriteResult> {
    const { apiUrl, botToken, groupNo, content, signal } = params;
    const bytes = Buffer.byteLength(content, 'utf-8');
    if (bytes > MAX_GROUP_MD_CONTENT_BYTES) {
      // Reject locally — do NOT hit the server (it would answer 400).
      throw new GroupMdContentTooLargeError(bytes);
    }
    return this.withLock(groupNo, async () => {
      const { version } = await this.updateFn({ apiUrl, botToken, groupNo, content, signal });
      // Write the just-persisted content/version back into A's in-memory cache
      // so the next resolveGroupInstructions serves what we wrote instead of
      // either re-fetching (TTL) or, worse, returning a now-stale cached copy.
      // updated_at is null because the PUT response carries only { version }.
      this.cache.set(groupNo, {
        content,
        version: typeof version === 'number' ? version : 0,
        updated_at: null,
      });
      return { groupNo, version, bytes };
    });
  }
}
