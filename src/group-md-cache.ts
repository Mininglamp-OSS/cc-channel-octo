/**
 * GROUP.md server cache (P2-A).
 *
 * A two-tier cache for server-fetched GROUP.md, keyed by groupNo:
 *   - in-memory Map (hot path: read on every group turn),
 *   - on-disk durable copy (`<groupNo>.md` for content + `<groupNo>.meta.json`
 *     for version / updated_at / updated_by) so a fetched GROUP.md survives a
 *     restart and can serve as a fallback when the server is unreachable.
 *
 * This module is deliberately INDEPENDENT of the P1 GroupContext caches
 * (group_messages / group_members in SQLite): those hold per-channel chat
 * history + roster; this holds operator-authored instruction text. Keeping them
 * decoupled means a GROUP.md refresh never touches the message DB and vice
 * versa.
 *
 * Freshness: this class only stores and serves; it does not expire entries on a
 * timer. A populated entry is returned until `invalidate()` is called — the
 * event-driven refresh that decides WHEN to invalidate is a separate work item.
 * Holding a stable value between invalidations is also what keeps the agent's
 * cached system prompt byte-identical turn-to-turn (see CLAUDE.md "Frozen system
 * prompt").
 *
 * Never throws — disk I/O failures degrade to "memory only" (or "no cache"),
 * never failing the turn.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** A cached GROUP.md plus the server metadata that came with it. */
export interface GroupMdEntry {
  content: string;
  version: number;
  updated_at: string | null;
  updated_by?: string;
}

/**
 * Only allow groupNos that are safe as a single path segment, so a crafted id
 * can never escape the cache dir. Same policy as group-config.ts isSafeId.
 */
function isSafeGroupNo(groupNo: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(groupNo) && groupNo !== '.' && groupNo !== '..';
}

export class GroupMdCache {
  private readonly mem = new Map<string, GroupMdEntry>();
  private readonly cacheDir?: string;
  /** Set once we've successfully created cacheDir (lazy: only when first written). */
  private dirReady = false;

  /**
   * @param cacheDir directory for the durable copy. When undefined the cache is
   *   memory-only (still correct, just not restart-durable).
   */
  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir;
  }

  /**
   * Read a cached entry. Checks memory first, then the on-disk copy (hydrating
   * memory on a disk hit so the next read is hot). Returns undefined on a miss
   * or for an unsafe groupNo.
   */
  get(groupNo: string): GroupMdEntry | undefined {
    if (!isSafeGroupNo(groupNo)) return undefined;
    const hot = this.mem.get(groupNo);
    if (hot) return hot;
    const fromDisk = this.readDisk(groupNo);
    if (fromDisk) this.mem.set(groupNo, fromDisk);
    return fromDisk;
  }

  /** Store an entry in memory and (best-effort) on disk. */
  set(groupNo: string, entry: GroupMdEntry): void {
    if (!isSafeGroupNo(groupNo)) return;
    this.mem.set(groupNo, entry);
    this.writeDisk(groupNo, entry);
  }

  /**
   * Drop a cached entry from memory and disk. The hook the event-driven refresh
   * (separate work item) calls when the server reports a GROUP.md changed, so
   * the next turn re-fetches.
   */
  invalidate(groupNo: string): void {
    if (!isSafeGroupNo(groupNo)) return;
    this.mem.delete(groupNo);
    if (!this.cacheDir) return;
    for (const name of [`${groupNo}.md`, `${groupNo}.meta.json`]) {
      try {
        rmSync(join(this.cacheDir, name), { force: true });
      } catch (err) {
        console.error(`[cc-channel-octo] group-md-cache: invalidate ${name} failed: ${String(err)}`);
      }
    }
  }

  private ensureDir(): boolean {
    if (!this.cacheDir) return false;
    if (this.dirReady) return true;
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      this.dirReady = true;
      return true;
    } catch (err) {
      console.error(`[cc-channel-octo] group-md-cache: mkdir ${this.cacheDir} failed: ${String(err)}`);
      return false;
    }
  }

  private readDisk(groupNo: string): GroupMdEntry | undefined {
    if (!this.cacheDir) return undefined;
    const contentPath = join(this.cacheDir, `${groupNo}.md`);
    const metaPath = join(this.cacheDir, `${groupNo}.meta.json`);
    try {
      if (!existsSync(contentPath)) return undefined;
      const content = readFileSync(contentPath, 'utf-8');
      let version = 0;
      let updatedAt: string | null = null;
      let updatedBy: string | undefined;
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Partial<GroupMdEntry>;
          if (typeof meta.version === 'number') version = meta.version;
          if (typeof meta.updated_at === 'string' || meta.updated_at === null) updatedAt = meta.updated_at ?? null;
          if (typeof meta.updated_by === 'string') updatedBy = meta.updated_by;
        } catch {
          // Corrupt meta — keep the content, default the metadata.
        }
      }
      return { content, version, updated_at: updatedAt, updated_by: updatedBy };
    } catch (err) {
      console.error(`[cc-channel-octo] group-md-cache: read ${groupNo} failed: ${String(err)}`);
      return undefined;
    }
  }

  private writeDisk(groupNo: string, entry: GroupMdEntry): void {
    if (!this.ensureDir() || !this.cacheDir) return;
    try {
      writeFileSync(join(this.cacheDir, `${groupNo}.md`), entry.content, 'utf-8');
      const meta = {
        version: entry.version,
        updated_at: entry.updated_at,
        updated_by: entry.updated_by,
      };
      writeFileSync(join(this.cacheDir, `${groupNo}.meta.json`), JSON.stringify(meta), 'utf-8');
    } catch (err) {
      console.error(`[cc-channel-octo] group-md-cache: write ${groupNo} failed: ${String(err)}`);
    }
  }
}
