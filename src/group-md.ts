/**
 * GROUP.md / THREAD.md resolution: server-first fetch with a never-lose
 * local-file fallback, behind a feature flag.
 *
 * `resolveGroupInstructions` is the single entry point the message pipeline
 * calls to obtain the trusted per-conversation instruction block injected into
 * the agent's system prompt.
 *
 * 🔴 Thread vs group are MUTUALLY EXCLUSIVE (老板拍板口径, #88 P3). The entry
 * point routes on channelId shape:
 *   - A thread (`<groupNo>____<shortId>`, CommunityTopic) resolves its OWN
 *     THREAD.md only. It NEVER falls back to — nor stacks — the parent group's
 *     GROUP.md, and it NEVER reads or writes the group's `groupMdCache` (which
 *     is keyed by the parent groupNo). See `resolveThreadInstructions`.
 *   - A plain group (`<groupNo>`, no separator) resolves its GROUP.md exactly as
 *     before — the group branch below is byte-for-byte the pre-P3 behavior.
 *
 * The bug this fixes (XIN-224): the old resolver collapsed EVERY channelId to
 * its parent groupNo via `extractParentGroupNo`, so with `serverMd` on a thread
 * message was injected the parent group's GROUP.md — violating the redline that
 * a thread injects only its own THREAD.md.
 *
 * Group-branch resolution order (unchanged):
 *   1. Feature flag OFF (default) or no cache wired → pure local file
 *      (`loadGroupConfig`). Byte-identical to the pre-P2 behavior.
 *   2. Feature flag ON:
 *        a. serve a cached server GROUP.md if present and not past its TTL (keyed
 *           by the group number). The cache is IN-MEMORY ONLY (no disk), so the
 *           only way content reaches this trusted system-prompt channel is a
 *           live, authenticated fetch — never a forgeable on-disk artifact
 *           (review #172 🔴; see group-md-cache.ts);
 *        b. otherwise fetch from the server (server-first). On success with
 *           non-empty content, cache it and use it;
 *        c. on ANY failure (404 "no GROUP.md", network, timeout, empty content)
 *           fall back to the local file. The local-file path is never lost.
 *
 * Thread-branch resolution order (P3-1) mirrors the group branch, keyed by the
 * COMPOSITE `<groupNo>::<shortId>` (see `resolveThreadInstructions`), gated on
 * the independent `threadMd` flag; when the flag is off a thread still resolves
 * its local `<shortId>.md` (already the correct non-stacking behavior).
 *
 * Trust: server content stands on its own trust root — an authenticated
 * `getGroupMd` / `getThreadMd` over the bot token against the SSRF-validated
 * `apiUrl` — NOT on the OS-permission trust the local `groupConfigDir` file
 * relies on. By caching only in memory we never let server content masquerade
 * as (or be confused with) a trusted local file on disk.
 *
 * Never throws — a server error degrades to local, a local miss degrades to
 * "no custom instructions".
 */

import { getGroupMd, getThreadMd } from './octo/api.js';
import { extractParentGroupNo, extractThreadShortId, isThreadChannelId } from './octo/channel-id.js';
import { loadGroupConfig, MAX_GROUP_CONFIG_BYTES } from './group-config.js';
import type { GroupMdCache, GroupMdEntry, ThreadMdCache } from './group-md-cache.js';

/**
 * Trim and byte-bound server-provided GROUP.md the same way loadGroupConfig
 * bounds a local file, so an oversized server payload can't blow the prompt
 * budget. Returns undefined for empty/whitespace-only content.
 */
function boundInstructions(content: string): string | undefined {
  let text = content;
  if (Buffer.byteLength(text, 'utf-8') > MAX_GROUP_CONFIG_BYTES) {
    const buf = Buffer.from(text, 'utf-8').subarray(0, MAX_GROUP_CONFIG_BYTES);
    // The slice may end mid-codepoint; trim a trailing replacement char.
    text = buf.toString('utf-8').replace(/�+$/, '') + '\n[… group config truncated]';
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface ResolveGroupInstructionsParams {
  /** Operator local-instruction directory (the existing fallback source). */
  groupConfigDir?: string;
  /** Feature flag: when false/undefined, server GROUP.md fetch is skipped. */
  serverMd?: boolean;
  /**
   * P3-1 feature flag: when true, a THREAD channel resolves its THREAD.md
   * server-first (GET /v1/bot/groups/{groupNo}/threads/{shortId}/md) before its
   * local `<shortId>.md`. When false/undefined (default) a thread resolves ONLY
   * its local file — which is already the correct non-stacking behavior, so the
   * flag gates the NEW server-read capability, not the bug fix. Independent of
   * `serverMd` (which governs the group server-read path).
   */
  threadMd?: boolean;
  apiUrl: string;
  botToken: string;
  /** Full channelId (may be a `<groupNo>____<shortId>` thread composite). */
  channelId: string;
  /** Server GROUP.md cache (group branch). Omitted (or flag off) → pure local. */
  cache?: GroupMdCache;
  /** Server THREAD.md cache (thread branch). Omitted (or flag off) → pure local. */
  threadCache?: ThreadMdCache;
  signal?: AbortSignal;
}

export async function resolveGroupInstructions(
  params: ResolveGroupInstructionsParams,
): Promise<string | undefined> {
  // 🔴 Thread and group are mutually exclusive. A thread resolves ONLY its own
  // THREAD.md and must never touch the parent group's GROUP.md nor its cache.
  if (isThreadChannelId(params.channelId)) {
    return resolveThreadInstructions(params);
  }
  return resolveGroupBranch(params);
}

/**
 * Plain-group branch — byte-for-byte the pre-P3 `resolveGroupInstructions`
 * behavior (server-first GROUP.md + in-memory cache keyed by groupNo + never-
 * lose local `<groupNo>.md` fallback). Reached only for non-thread channelIds.
 */
async function resolveGroupBranch(
  params: ResolveGroupInstructionsParams,
): Promise<string | undefined> {
  const { groupConfigDir, serverMd, apiUrl, botToken, channelId, cache, signal } = params;

  const local = (): string | undefined => loadGroupConfig(groupConfigDir, channelId);

  // Flag off (or no cache to dedupe fetches) → pure local file, unchanged behavior.
  if (!serverMd || !cache) return local();

  const groupNo = extractParentGroupNo(channelId);

  // a) fresh cached server GROUP.md wins. The cache is in-memory only and TTL-
  //    bounded, so an expired entry reads as a miss and falls through to a
  //    re-fetch below (staleness backstop; item B adds event-driven refresh).
  const cached = cache.get(groupNo);
  if (cached) {
    const bounded = boundInstructions(cached.content);
    if (bounded) return bounded;
    // Cached-but-empty (shouldn't normally happen) → fall through to local.
    return local();
  }

  // b) server-first fetch.
  try {
    const md = await getGroupMd({ apiUrl, botToken, groupNo, signal });
    const bounded = boundInstructions(md?.content ?? '');
    if (bounded) {
      const entry: GroupMdEntry = {
        content: md.content,
        version: typeof md.version === 'number' ? md.version : 0,
        updated_at: md.updated_at ?? null,
        updated_by: md.updated_by,
      };
      cache.set(groupNo, entry);
      return bounded;
    }
    // Server reachable but no/empty GROUP.md → local fallback.
    return local();
  } catch (err) {
    // c) 404 / network / timeout — never-lose local fallback.
    console.error(
      `[cc-channel-octo] group-md: server fetch for ${groupNo} failed, falling back to local: ${String(err)}`,
    );
    return local();
  }
}

/**
 * Thread branch (P3-1) — resolves a CommunityTopic thread's OWN THREAD.md.
 *
 * 🔴 By construction this branch NEVER reads or writes the group `cache`
 * (keyed by parent groupNo) and NEVER calls `getGroupMd`, so a thread can never
 * be injected — or have cached — its parent group's GROUP.md.
 *
 * Resolution mirrors the group branch, keyed by the COMPOSITE `groupNo::shortId`:
 *   - `threadMd` off (or no thread cache) → local `<shortId>.md` only
 *     (`loadGroupConfig` is already thread-aware). This is the correct
 *     non-stacking behavior even with the new server capability disabled.
 *   - `threadMd` on:
 *       a. serve a fresh cached THREAD.md (in-memory only, TTL-bounded);
 *       b. else server-first `getThreadMd`, cache non-empty content and use it;
 *       c. on ANY failure / empty → never-lose local `<shortId>.md` fallback.
 */
async function resolveThreadInstructions(
  params: ResolveGroupInstructionsParams,
): Promise<string | undefined> {
  const { groupConfigDir, threadMd, apiUrl, botToken, channelId, threadCache, signal } = params;

  // Local fallback keeps the FULL channelId — loadGroupConfig routes a thread to
  // its own `<shortId>.md`, never the parent group's `<groupNo>.md`.
  const local = (): string | undefined => loadGroupConfig(groupConfigDir, channelId);

  // Flag off (or no thread cache) → pure local `<shortId>.md`. Already correct
  // non-stacking behavior — the flag only gates the server-read capability.
  if (!threadMd || !threadCache) return local();

  const groupNo = extractParentGroupNo(channelId);
  const shortId = extractThreadShortId(channelId);
  // A malformed thread channelId (`<groupNo>____` with no shortId) can't be
  // server-keyed — degrade to local rather than fetch a group-scoped path.
  if (!shortId) return local();

  // a) fresh cached server THREAD.md wins. Composite-keyed, in-memory only,
  //    TTL-bounded (expired → miss → re-fetch below).
  const cached = threadCache.get(groupNo, shortId);
  if (cached) {
    const bounded = boundInstructions(cached.content);
    if (bounded) return bounded;
    // Cached-but-empty (shouldn't normally happen) → fall through to local.
    return local();
  }

  // b) server-first fetch of this thread's own THREAD.md.
  try {
    const md = await getThreadMd({ apiUrl, botToken, groupNo, shortId, signal });
    const bounded = boundInstructions(md?.content ?? '');
    if (bounded) {
      const entry: GroupMdEntry = {
        content: md.content,
        version: typeof md.version === 'number' ? md.version : 0,
        updated_at: md.updated_at ?? null,
        updated_by: md.updated_by,
      };
      threadCache.set(groupNo, shortId, entry);
      return bounded;
    }
    // Server reachable but no/empty THREAD.md → local fallback.
    return local();
  } catch (err) {
    // c) 404 / network / timeout — never-lose local fallback.
    console.error(
      `[cc-channel-octo] thread-md: server fetch for ${groupNo}::${shortId} failed, falling back to local: ${String(err)}`,
    );
    return local();
  }
}
