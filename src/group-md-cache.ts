/**
 * GROUP.md server cache (P2-A) — IN-MEMORY ONLY, with a TTL.
 *
 * Holds server-fetched GROUP.md keyed by groupNo, in a process-local Map. There
 * is deliberately **no on-disk persistence** (see SECURITY below).
 *
 * Independent of the P1 GroupContext caches (group_messages / group_members in
 * SQLite): those hold per-channel chat history + roster; this holds operator-
 * authored instruction text. Keeping them decoupled means a GROUP.md refresh
 * never touches the message DB and vice versa.
 *
 * SECURITY — why memory-only (review #172, 🔴 durable-cache poisoning):
 *   The resolved GROUP.md is injected into the agent's system prompt as a TRUSTED
 *   instruction block (same channel as the operator's local `groupConfigDir`
 *   file). A local file earns that trust from OS permissions (operator-owned,
 *   non-writable by others; `group-config.ts` additionally refuses a group/world-
 *   writable file). A DISK cache cannot earn the same trust here: the gateway
 *   runs the agent under `bypassPermissions` with `Bash`/`Write`, so the agent
 *   process — drivable by untrusted chat input — can write any file the gateway
 *   user owns, including a cache file. A persisted cache entry would then be read
 *   back and injected as trusted across restarts (a chat-injection → trusted-
 *   prompt poisoning that survives reboot), and the `0o022` perm check is useless
 *   because agent == gateway user. So GROUP.md from the server is cached ONLY in
 *   memory: the sole path content can enter the trusted channel is a live,
 *   authenticated `getGroupMd` over the bot token against the SSRF-validated
 *   `apiUrl` (server-side bot_admin-gated) — never a forgeable on-disk artifact.
 *   The tradeoff (no cross-restart durability) is acceptable: a cold start simply
 *   re-fetches, and the local file remains the offline fallback.
 *
 * Freshness: an entry expires `ttlMs` after it was stored; an expired read is a
 * miss (the resolver re-fetches). This is a staleness BACKSTOP so a server-side
 * GROUP.md edit eventually takes effect (review #172, 🟡) — Stage 2 (item B) adds
 * event-driven invalidation on top; the two do not conflict.
 *
 * Never throws.
 */

/** A cached GROUP.md plus the server metadata that came with it. */
export interface GroupMdEntry {
  content: string;
  version: number;
  updated_at: string | null;
  updated_by?: string;
}

/** Default staleness backstop: re-fetch a cached GROUP.md at most this old. */
export const DEFAULT_GROUP_MD_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Only allow groupNos that are safe as a single Map key / log token. Mirrors
 * group-config.ts isSafeId — cheap defense-in-depth against a crafted id even
 * though nothing here touches the filesystem anymore.
 */
function isSafeGroupNo(groupNo: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(groupNo) && groupNo !== '.' && groupNo !== '..';
}

interface StoredEntry {
  entry: GroupMdEntry;
  storedAt: number;
}

export class GroupMdCache {
  private readonly mem = new Map<string, StoredEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  /**
   * @param ttlMs staleness backstop in ms (entry expires this long after it was
   *   stored). Defaults to {@link DEFAULT_GROUP_MD_TTL_MS}. A non-positive value
   *   disables expiry (entries live until invalidate()).
   * @param now injectable clock (testing); defaults to Date.now.
   */
  constructor(ttlMs: number = DEFAULT_GROUP_MD_TTL_MS, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /**
   * Read a cached entry from memory. Returns undefined on a miss, an expired
   * entry (which is also evicted), or an unsafe groupNo.
   */
  get(groupNo: string): GroupMdEntry | undefined {
    if (!isSafeGroupNo(groupNo)) return undefined;
    const stored = this.mem.get(groupNo);
    if (!stored) return undefined;
    if (this.ttlMs > 0 && this.now() - stored.storedAt >= this.ttlMs) {
      this.mem.delete(groupNo);
      return undefined;
    }
    return stored.entry;
  }

  /** Store an entry in memory, stamping it for TTL expiry. */
  set(groupNo: string, entry: GroupMdEntry): void {
    if (!isSafeGroupNo(groupNo)) return;
    this.mem.set(groupNo, { entry, storedAt: this.now() });
  }

  /**
   * Drop a cached entry. The hook the event-driven refresh (item B) calls when
   * the server reports a GROUP.md changed, so the next turn re-fetches.
   */
  invalidate(groupNo: string): void {
    if (!isSafeGroupNo(groupNo)) return;
    this.mem.delete(groupNo);
  }
}
