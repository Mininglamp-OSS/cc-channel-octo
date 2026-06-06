/**
 * Q3: Per-session cwd isolation under a shared `cwdBase`.
 *
 * Each session maps to a deterministic 16-hex sha256 prefix directory inside
 * `cwdBase`, so one user's working tree cannot be read or mutated from another
 * user's session while operators still allocate a single disk root for the bot.
 *
 * The partition key is the *exact* `sessionKey` the SessionRouter already
 * produced for history (`SessionRouter.sessionKey()`), prefixed by the channel
 * kind. Reusing the router key verbatim — rather than re-deriving spaceId or
 * channel_id from the raw message — guarantees the cwd partition can never
 * drift from the history partition:
 *
 *   - DM:    sessionKey = `${spaceId}:${uid}` (or bare `uid`)   → `dm:<key>`
 *   - Group: sessionKey = `${channel_id}:${uid}`                → `group:<key>`
 *
 * Because the group sessionKey embeds `from_uid`, every group member gets their
 * OWN sandbox (matching how group history is partitioned per-user), not a
 * shared per-channel workspace. The `kind` prefix keeps a DM key and a group
 * key that happen to be byte-identical from colliding.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Per-session routing context for cwd isolation. `kind` is the channel class
 * and `sessionKey` is the router-produced key the session's history is stored
 * under — see `SessionRouter.sessionKey()`. Passing the router key directly
 * (instead of re-deriving uid/spaceId/channel_id here) is what keeps the cwd
 * and history partitions byte-for-byte consistent.
 */
export type SessionCtx = {
  kind: 'dm' | 'group';
  sessionKey: string;
};

/** Length of the hex prefix used for subdirectory names. 16 hex = 64 bits — */
/** ~2^32 sessions before a 1% collision risk, ample headroom for IM use.    */
const HASH_HEX_LEN = 16;

/** Cleanup interval guard: only paths matching this shape are eligible for */
/** TTL deletion so a misconfigured cwdBase (pointing at $HOME, etc.) can   */
/** never wipe legitimate user files.                                       */
const SESSION_DIR_RE = /^[0-9a-f]{16}$/;

/**
 * Provenance is recorded in a sidecar *registry* directory at the root of
 * `cwdBase`, NOT inside each session dir. Each session we create gets a 0-byte
 * marker `cwdBase/.cc-octo-sessions/<hexname>`. Cleanup only deletes a 16-hex
 * dir that has a matching registry entry, so:
 *
 *   - A `cwdBase` accidentally pointed at another tool's hex-keyed store can
 *     never be rmSync'd by us (P0-3).
 *   - The marker lives OUTSIDE the agent's own working directory, so a
 *     user-driven agent (which operates via relative paths inside its cwd)
 *     cannot delete its marker to evade cleanup, nor forge a marker for a
 *     sibling/operator directory to get it deleted. (Absolute-path access is a
 *     separate, documented limitation — cwd is a starting dir, not a chroot.)
 *   - The marker is re-created on every resolve if missing, so a transient
 *     first-write failure cannot permanently exempt a live dir from the TTL.
 */
const SESSION_REGISTRY_DIR = '.cc-octo-sessions';

/** 7 days — long enough for a vacation, short enough to bound disk growth. */
export const DEFAULT_CWD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, HASH_HEX_LEN);
}

function sessionKeyToString(ctx: SessionCtx): string {
  // Prefix the router key with the channel kind so a DM key and a group key
  // that happen to be byte-identical can never resolve to the same sandbox.
  return `${ctx.kind}:${ctx.sessionKey}`;
}

/**
 * Resolve and ensure the per-session cwd exists. Idempotent — safe to call
 * on every turn. Returns the absolute path under `cwdBase`.
 *
 * Note: the TTL tracks last *bot turn* (this function bumps the dir mtime on
 * every call), not arbitrary filesystem activity inside the sandbox. A session
 * with no inbound message for `ttlMs` is reclaimed even if a background process
 * is still touching files inside it.
 */
export function resolveSessionCwd(cwdBase: string, ctx: SessionCtx): string {
  const name = hashKey(sessionKeyToString(ctx));
  const dir = join(cwdBase, name);
  mkdirSync(dir, { recursive: true });

  // Record provenance in the sidecar registry (outside the agent's cwd). Best
  // effort, but re-attempted on every resolve so a transient failure self-heals
  // on the next turn rather than exempting the dir from cleanup forever.
  const registryDir = join(cwdBase, SESSION_REGISTRY_DIR);
  const marker = join(registryDir, name);
  if (!existsSync(marker)) {
    try {
      mkdirSync(registryDir, { recursive: true });
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
 * A dir is eligible for deletion only when ALL hold: the name matches the
 * 16-hex pattern, it is a real directory (not a symlink), and it has a matching
 * entry in the `.cc-octo-sessions` registry (P0-3). The registry entry is
 * removed alongside the dir.
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

  const registryDir = join(cwdBase, SESSION_REGISTRY_DIR);
  const cutoff = Date.now() - ttlMs;
  for (const name of entries) {
    if (!SESSION_DIR_RE.test(name)) continue; // never touch unrelated files
    const full = join(cwdBase, name);
    const marker = join(registryDir, name);
    // P0-3: only sweep dirs we provably created (registry entry present). A
    // 16-hex dir without a registry entry belongs to someone else — leave it
    // untouched no matter its age.
    if (!existsSync(marker)) continue;
    try {
      // lstatSync (not statSync) so a symlinked entry is never followed; a real
      // session dir is always a plain directory.
      const st = lstatSync(full);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs >= cutoff) continue;
      rmSync(full, { recursive: true, force: true });
      rmSync(marker, { force: true }); // drop the registry entry too
    } catch (err) {
      console.error(
        `[cc-channel-octo] cwd cleanup failed for ${full}: ${String(err)}`,
      );
    }
  }
}
