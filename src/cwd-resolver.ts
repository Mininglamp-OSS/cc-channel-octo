/**
 * Q3: Per-session cwd isolation under a shared `cwdBase`.
 *
 * Each (DM peer | group | thread) maps to a deterministic 16-hex sha256 prefix
 * directory inside `cwdBase`. This prevents one user's session from reading or
 * mutating another user's working tree while letting operators allocate a
 * single disk root for the bot.
 *
 * The hash inputs are namespaced (`dm:`, `group:`, `group:<id>:thread:<id>`)
 * so that the same string used as a uid vs. a group id can never collide.
 *
 * DM keys may additionally be scoped by `spaceId` so the cwd partition matches
 * SessionRouter.sessionKey(): the same uid messaging from two different spaces
 * gets two history sessions, hence must get two sandboxes too (P0-2).
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type SessionCtx =
  | { kind: 'dm'; userId: string; spaceId?: string }
  | { kind: 'group'; groupId: string }
  // NOTE: the `thread` variant is reserved for future wiring. The current Octo
  // BotMessage shape exposes no thread/topic id, so only `dm` and `group` are
  // ever emitted by index.ts today. Kept here (with hashing + tests) so the
  // routing contract is ready the moment threads land upstream.
  | { kind: 'thread'; groupId: string; threadId: string };

/** Length of the hex prefix used for subdirectory names. 16 hex = 64 bits — */
/** ~2^32 sessions before a 1% collision risk, ample headroom for IM use.    */
const HASH_HEX_LEN = 16;

/** Cleanup interval guard: only paths matching this shape are eligible for */
/** TTL deletion so a misconfigured cwdBase (pointing at $HOME, etc.) can   */
/** never wipe legitimate user files.                                       */
const SESSION_DIR_RE = /^[0-9a-f]{16}$/;

/**
 * Provenance marker written into every session dir we create. Cleanup only
 * deletes a 16-hex dir that ALSO contains this marker, so a cwdBase that is
 * accidentally pointed at some other tool's cache of identically-named dirs
 * (e.g. another hex-keyed store) can never be rmSync'd by us (P0-3).
 */
const SESSION_MARKER_FILE = '.cc-octo-session';

/** 7 days — long enough for a vacation, short enough to bound disk growth. */
export const DEFAULT_CWD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, HASH_HEX_LEN);
}

function sessionKeyToString(ctx: SessionCtx): string {
  switch (ctx.kind) {
    case 'dm':
      // P0-2: mirror SessionRouter.sessionKey() — scope by space when present
      // so the same uid in different spaces resolves to different sandboxes.
      // Omitting spaceId keeps the legacy `dm:<uid>` hash for backward compat.
      return ctx.spaceId
        ? `dm:${ctx.spaceId}:${ctx.userId}`
        : `dm:${ctx.userId}`;
    case 'group':
      return `group:${ctx.groupId}`;
    case 'thread':
      return `group:${ctx.groupId}:thread:${ctx.threadId}`;
  }
}

/**
 * Resolve and ensure the per-session cwd exists. Idempotent — safe to call
 * on every turn. Returns the absolute path under `cwdBase`.
 */
export function resolveSessionCwd(cwdBase: string, ctx: SessionCtx): string {
  const dir = join(cwdBase, hashKey(sessionKeyToString(ctx)));
  mkdirSync(dir, { recursive: true });

  // P0-3: drop a provenance marker so cleanupExpiredCwds can distinguish our
  // own session dirs from unrelated 16-hex dirs. Written once; best-effort.
  const marker = join(dir, SESSION_MARKER_FILE);
  if (!existsSync(marker)) {
    try {
      writeFileSync(
        marker,
        JSON.stringify({ created: new Date().toISOString(), kind: ctx.kind }),
      );
    } catch (err) {
      console.error(
        `[cc-channel-octo] cwd marker write failed for ${dir}: ${String(err)}`,
      );
    }
  }

  // P0-1: mkdirSync does NOT touch mtime on an already-existing dir, so an
  // actively-used session created >7d ago would be swept by cleanupExpiredCwds
  // on its next turn. Refresh atime+mtime to "now" on every resolve so the TTL
  // tracks last activity. Wrapped: a concurrent rmSync race must not crash the
  // request — worst case the dir is recreated on the next turn.
  try {
    const now = new Date();
    utimesSync(dir, now, now);
  } catch (err) {
    console.error(
      `[cc-channel-octo] cwd mtime refresh failed for ${dir}: ${String(err)}`,
    );
  }

  return dir;
}

/**
 * Sweep `cwdBase` for hashed session dirs whose mtime is older than `ttlMs`
 * and remove them. Best-effort: failures are logged, never thrown — the bot
 * must continue running even if disk cleanup hits a permission error.
 *
 * Silent no-op when `cwdBase` does not exist (e.g. first-run before any
 * session has been resolved).
 *
 * A dir is eligible for deletion only when BOTH the name matches the 16-hex
 * pattern AND it carries our `.cc-octo-session` provenance marker (P0-3).
 */
export function cleanupExpiredCwds(
  cwdBase: string,
  ttlMs: number = DEFAULT_CWD_TTL_MS,
): void {
  let entries: string[];
  try {
    entries = readdirSync(cwdBase);
  } catch {
    // cwdBase missing / unreadable — nothing to clean.
    return;
  }

  const cutoff = Date.now() - ttlMs;
  for (const name of entries) {
    if (!SESSION_DIR_RE.test(name)) continue; // never touch unrelated files
    const full = join(cwdBase, name);
    // P0-3: only sweep dirs we provably created. A 16-hex dir without our
    // marker belongs to someone else — leave it untouched no matter its age.
    if (!existsSync(join(full, SESSION_MARKER_FILE))) continue;
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs >= cutoff) continue;
      rmSync(full, { recursive: true, force: true });
    } catch (err) {
      console.error(
        `[cc-channel-octo] cwd cleanup failed for ${full}: ${String(err)}`,
      );
    }
  }
}
