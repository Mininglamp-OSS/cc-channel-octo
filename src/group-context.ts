/**
 * Group Context — group chat message cache + maxContextChars budget + mention mapping.
 */

import type { DbAdapter, PreparedStatement } from './db-adapter.js';
import { getGroupMembers, fetchUserInfo } from './octo/api.js';
import { extractParentGroupNo } from './octo/channel-id.js';
import { sanitizeDisplayName } from './prompt-safety.js';

interface GroupMessage {
  fromUid: string;
  fromName: string;
  content: string;
  timestamp: number;
}

interface MemberRow {
  uid: string;
  name: string;
}

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export class GroupContext {
  private readonly messageCache = new Map<string, GroupMessage[]>();
  // Per-channel member maps to avoid cross-group name collisions
  private readonly memberMapByChannel = new Map<string, Map<string, string>>(); // channelId → uid → name
  private readonly nameToUidByChannel = new Map<string, Map<string, string>>(); // channelId → name → uid
  // G23: per-channel robot flag map (channelId → uid → isRobot).
  // Populated from refreshMembers; stored for future routing integrations
  // (e.g. 免@ gate that should treat bot members differently).
  private readonly robotFlags = new Map<string, Map<string, boolean>>();
  private readonly lastRefresh = new Map<string, number>();

  private readonly adapter: DbAdapter;
  private readonly maxContextChars: number;
  private readonly maxWindowSize: number;

  private upsertMember!: PreparedStatement;
  private deleteMember!: PreparedStatement;
  private selectMembers!: PreparedStatement;
  private insertMessage!: PreparedStatement;
  private selectRecentMessages!: PreparedStatement;
  private deleteOldMessages!: PreparedStatement;
  private selectMessagesSince!: PreparedStatement;
  private selectMaxId!: PreparedStatement;
  private upsertCursor!: PreparedStatement;
  private selectCursor!: PreparedStatement;

  constructor(adapter: DbAdapter, maxContextChars: number) {
    this.adapter = adapter;
    this.maxContextChars = maxContextChars;
    this.maxWindowSize = 100;
    this.initStatements();
  }

  private initStatements(): void {
    this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        from_uid TEXT NOT NULL,
        from_name TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    this.adapter.exec(`
      CREATE INDEX IF NOT EXISTS idx_group_messages_channel
      ON group_messages (channel_id, id DESC)
    `);
    // Per-channel consumption cursor: the highest group_messages.id that has
    // already been injected into a turn for this channel. Only group messages
    // NEWER than this are injected next turn (the bot's standing context lives in
    // the SDK session, so re-injecting the whole window every turn would be both
    // redundant and a frozen-prompt violation). Mirrors the reset_barriers /
    // sdk_sessions single-row-per-key pattern.
    this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS group_context_cursors (
        channel_id TEXT PRIMARY KEY,
        last_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.upsertMember = this.adapter.prepare(
      'INSERT INTO group_members (group_id, uid, name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(group_id, uid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at',
    );
    this.deleteMember = this.adapter.prepare(
      'DELETE FROM group_members WHERE group_id = ? AND uid = ?',
    );
    this.selectMembers = this.adapter.prepare(
      'SELECT uid, name FROM group_members WHERE group_id = ?',
    );
    this.insertMessage = this.adapter.prepare(
      'INSERT INTO group_messages (channel_id, from_uid, from_name, content, timestamp) VALUES (?, ?, ?, ?, ?)',
    );
    this.selectRecentMessages = this.adapter.prepare(
      'SELECT from_uid, from_name, content, timestamp FROM group_messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?',
    );
    this.deleteOldMessages = this.adapter.prepare(
      'DELETE FROM group_messages WHERE channel_id = ? AND id NOT IN (SELECT id FROM group_messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?)',
    );
    // Cursor delta: messages strictly newer than the cursor, NEWEST-first so a
    // backlog larger than the fetch limit keeps the most-recent messages (the
    // relevant ones) rather than ancient ones. LIMIT (maxWindowSize=100) is <=
    // deleteOldMessages' retained 200, so every fetchable row survives trimming.
    // buildContextSince re-sorts the budget-selected slice into chronological
    // order for display. Mirrors the in-memory buildContext rolling-window.
    this.selectMessagesSince = this.adapter.prepare(
      'SELECT id, from_name, content FROM group_messages WHERE channel_id = ? AND id > ? ORDER BY id DESC LIMIT ?',
    );
    this.selectMaxId = this.adapter.prepare(
      'SELECT MAX(id) AS maxId FROM group_messages WHERE channel_id = ?',
    );
    this.upsertCursor = this.adapter.prepare(
      'INSERT INTO group_context_cursors (channel_id, last_id, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(channel_id) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at ' +
        'WHERE excluded.last_id > group_context_cursors.last_id',
    );
    this.selectCursor = this.adapter.prepare(
      'SELECT last_id FROM group_context_cursors WHERE channel_id = ?',
    );
  }

  private getMemberMap(channelId: string): Map<string, string> {
    let m = this.memberMapByChannel.get(channelId);
    if (!m) {
      m = new Map();
      this.memberMapByChannel.set(channelId, m);
    }
    return m;
  }

  private getNameToUid(channelId: string): Map<string, string> {
    let m = this.nameToUidByChannel.get(channelId);
    if (!m) {
      m = new Map();
      this.nameToUidByChannel.set(channelId, m);
    }
    return m;
  }

  pushMessage(
    channelId: string,
    fromUid: string,
    fromName: string,
    content: string,
    timestamp: number,
  ): void {
    // SECURITY: fromName is the user-controlled IM display name and is rendered
    // into the [Group context] block as `<name>：<content>`. Bound + strip it at
    // the boundary (shared choke point) so it can't forge a label/line. fromUid
    // is ALSO user-controlled, and sanitizeDisplayName returns its fallback
    // verbatim — so sanitize the uid fallback too rather than passing it raw
    // (PR #128 review: raw-uid-as-fallback re-introduces the injection).
    const safeName = sanitizeDisplayName(fromName) || sanitizeDisplayName(fromUid) || 'unknown';
    let window = this.messageCache.get(channelId);
    if (!window) {
      window = [];
      this.messageCache.set(channelId, window);
    }
    window.push({ fromUid, fromName: safeName, content, timestamp });
    while (window.length > this.maxWindowSize) {
      window.shift();
    }
    this.learnMember(channelId, fromUid, safeName);

    try {
      this.insertMessage.run(channelId, fromUid, safeName, content, timestamp);
      // Trim old messages to keep DB bounded (keep 2x window for safety)
      this.deleteOldMessages.run(channelId, channelId, this.maxWindowSize * 2);
    } catch (err) {
      console.error(`group-context: insert message failed: ${String(err)}`);
    }
  }

  learnMember(channelId: string, uid: string, name: string): void {
    if (!uid || !name) return;
    const memberMap = this.getMemberMap(channelId);
    const nameMap = this.getNameToUid(channelId);
    const existing = memberMap.get(uid);
    if (existing !== name) {
      // Remove old reverse mapping only if it still points to THIS uid.
      // If another user already claimed the same display name, don't clobber.
      if (existing && nameMap.get(existing) === uid) {
        nameMap.delete(existing);
      }
      memberMap.set(uid, name);
      nameMap.set(name, uid);
      try {
        this.upsertMember.run(channelId, uid, name, Date.now());
      } catch (err) {
        console.error(`group-context: upsert member failed: ${String(err)}`);
      }
    }
  }

  async refreshMembers(channelId: string, apiUrl: string, botToken: string): Promise<void> {
    const now = Date.now();
    const last = this.lastRefresh.get(channelId) ?? 0;
    if (now - last < REFRESH_INTERVAL_MS) return;
    // Don't set lastRefresh here — only on success

    try {
      // Redline 6 (#88): the roster endpoint is keyed by the PARENT group number.
      // A thread channelId is the composite `<groupNo>____<shortId>`; hitting
      // `/groups/<groupNo>____<shortId>/members` 404s. Resolve the parent group
      // number for the API call while keeping every cache (memory + DB + robot
      // flags) keyed by the full channelId, so a thread keeps its own isolated
      // roster view. For a plain group channelId extractParentGroupNo is identity.
      const groupNo = extractParentGroupNo(channelId);
      const members = await getGroupMembers({ apiUrl, botToken, groupNo });
      this.lastRefresh.set(channelId, now); // Record only on success
      const memberMap = this.getMemberMap(channelId);
      const nameMap = this.getNameToUid(channelId);

      // A8 (#143, take 2): the server response is AUTHORITATIVE — it is the full
      // current roster, not a delta. Upserting returned members WITHOUT pruning
      // departed ones (the original #144 bug, Jerry-Xin's 🔴) left a user who
      // left the group cached forever, so isMember() kept accepting them and the
      // outbound mention guard let a stale @uid through. Track who the server
      // returned, then drop anyone cached/persisted who is no longer present.
      //
      // Best-effort caveat: this is only as fresh as the last successful refresh,
      // which is throttled to REFRESH_INTERVAL_MS (1h) and seeded from DB on
      // restart. A membership change inside that window is not reflected until
      // the next refresh — the outbound guard is defense-in-depth, not a
      // real-time authority. The server still enforces real permissions.
      const present = new Set<string>();
      for (const m of members) {
        if (!m.uid || !m.name) continue;
        present.add(m.uid);
        const oldName = memberMap.get(m.uid);
        if (oldName && oldName !== m.name && nameMap.get(oldName) === m.uid) {
          nameMap.delete(oldName);
        }
        memberMap.set(m.uid, m.name);
        nameMap.set(m.name, m.uid);
        // G23: Track server-authoritative robot flag for future 免@ gate.
        if (m.robot !== undefined) {
          let rfMap = this.robotFlags.get(channelId);
          if (!rfMap) {
            rfMap = new Map();
            this.robotFlags.set(channelId, rfMap);
          }
          rfMap.set(m.uid, m.robot === 1);
        }
        try {
          this.upsertMember.run(channelId, m.uid, m.name, now);
        } catch (err) {
          console.error(`group-context: upsert member failed: ${String(err)}`);
        }
      }

      // Prune members no longer in the authoritative roster (memory + DB + robot
      // flags). Iterate a snapshot of uids since we mutate the map in the loop.
      //
      // Guard: skip pruning when the roster came back EMPTY. getGroupMembers
      // returns [] not only for a genuinely empty group but also for a
      // malformed/unexpected-shape 200 response (data.members not an array →
      // silently []). A group the bot is in always has ≥1 member, so an empty
      // roster is far more likely a transient quirk than "everyone left".
      // Mass-pruning on it would wipe the whole roster — and since lastRefresh
      // was already set on this "success", it wouldn't re-fetch for an hour,
      // downgrading every mention to plain text in that window. Keep the prior
      // snapshot instead; a real emptying still prunes member-by-member as the
      // roster shrinks across non-empty responses.
      if (present.size > 0) {
        const rfMap = this.robotFlags.get(channelId);
        for (const uid of [...memberMap.keys()]) {
          if (present.has(uid)) continue;
          const staleName = memberMap.get(uid);
          memberMap.delete(uid);
          // Only remove the reverse entry if it still points at THIS uid (a rename
          // may have already re-pointed the name to someone else).
          if (staleName !== undefined && nameMap.get(staleName) === uid) {
            nameMap.delete(staleName);
          }
          rfMap?.delete(uid);
          try {
            this.deleteMember.run(channelId, uid);
          } catch (err) {
            console.error(`group-context: delete stale member failed: ${String(err)}`);
          }
        }
      }
    } catch (err) {
      console.error(`group-context: refreshMembers(${channelId}) failed: ${String(err)}`);
      // Don't update lastRefresh on failure — allow retry
    }
  }

  async fetchAndLearnUser(
    uid: string,
    channelId: string,
    apiUrl: string,
    botToken: string,
  ): Promise<string | undefined> {
    const memberMap = this.getMemberMap(channelId);
    const cached = memberMap.get(uid);
    if (cached) return cached;
    try {
      const info = await fetchUserInfo({ apiUrl, botToken, uid });
      if (info?.name) {
        this.learnMember(channelId, uid, info.name);
        return info.name;
      }
    } catch (err) {
      console.error(`group-context: fetchUserInfo(${uid}) failed: ${String(err)}`);
    }
    return undefined;
  }

  buildContext(channelId: string): string {
    const window = this.messageCache.get(channelId);
    if (!window || window.length === 0) return '';

    const header = '[Recent group messages]\n';
    const trailer = '\n';
    const budget = this.maxContextChars - header.length - trailer.length;
    if (budget <= 0) return '';

    const selected: string[] = [];
    let used = 0;
    for (let i = window.length - 1; i >= 0; i--) {
      const m = window[i];
      const line = `${m.fromName}：${m.content}`;
      const cost = line.length + (selected.length > 0 ? 1 : 0);
      if (used + cost > budget) break;
      selected.push(line);
      used += cost;
    }
    if (selected.length === 0) return '';
    selected.reverse();
    return `${header}${selected.join('\n')}${trailer}`;
  }

  /** Read the per-channel consumption cursor (highest already-injected id), or 0. */
  getContextCursor(channelId: string): number {
    try {
      const row = this.selectCursor.get(channelId) as { last_id: number } | undefined;
      return row?.last_id ?? 0;
    } catch (err) {
      console.error(`group-context: getContextCursor(${channelId}) failed: ${String(err)}`);
      return 0;
    }
  }

  /** Advance the per-channel cursor to `lastId` (monotonic — never moves backward). */
  setContextCursor(channelId: string, lastId: number): void {
    try {
      this.upsertCursor.run(channelId, lastId, Date.now());
    } catch (err) {
      console.error(`group-context: setContextCursor(${channelId}) failed: ${String(err)}`);
    }
  }

  /** The highest group_messages.id for a channel (for cursor priming), or 0. */
  getMaxMessageId(channelId: string): number {
    try {
      const row = this.selectMaxId.get(channelId) as { maxId: number | null } | undefined;
      return row?.maxId ?? 0;
    } catch (err) {
      console.error(`group-context: getMaxMessageId(${channelId}) failed: ${String(err)}`);
      return 0;
    }
  }

  /**
   * Build a group-context block from messages NEWER than `sinceId` (the delta the
   * model hasn't seen yet), within `maxContextChars`. Returns the block text (same
   * `[Recent group messages]` format as buildContext) and the highest id that
   * EXISTS in the channel above `sinceId` (so the caller advances the cursor past
   * the whole delta, including any oldest lines the char budget dropped — those
   * are the least-relevant and are intentionally not re-shown). Empty text + the
   * unchanged cursor when there's nothing new.
   *
   * Rows are fetched newest-first (so a backlog larger than the budget keeps the
   * most-recent messages); the selected slice is reversed back to chronological
   * order for display. Unlike buildContext (in-memory rolling window), this reads
   * from the DB so the cursor delta is exact even across restarts / window eviction.
   */
  buildContextSince(channelId: string, sinceId: number): { text: string; lastId: number } {
    let rows: Array<{ id: number; from_name: string; content: string }>;
    try {
      rows = this.selectMessagesSince.all(channelId, sinceId, this.maxWindowSize) as Array<{
        id: number;
        from_name: string;
        content: string;
      }>;
    } catch (err) {
      console.error(`group-context: buildContextSince(${channelId}) failed: ${String(err)}`);
      return { text: '', lastId: sinceId };
    }
    if (rows.length === 0) return { text: '', lastId: sinceId };

    // rows are newest-first; the highest id is the first row. Advance the cursor to
    // it regardless of what the budget keeps, so we never re-show a line.
    const lastId = rows[0].id;

    const header = '[Recent group messages]\n';
    const trailer = '\n';
    const budget = this.maxContextChars - header.length - trailer.length;
    if (budget <= 0) return { text: '', lastId };

    // Walk newest→oldest (rows[0] is newest) keeping lines within budget.
    const selected: string[] = [];
    let used = 0;
    for (let i = 0; i < rows.length; i++) {
      const line = `${rows[i].from_name}：${rows[i].content}`;
      const cost = line.length + (selected.length > 0 ? 1 : 0);
      if (used + cost > budget) break;
      selected.push(line);
      used += cost;
    }
    if (selected.length === 0) return { text: '', lastId };
    selected.reverse(); // chronological order for display
    return { text: `${header}${selected.join('\n')}${trailer}`, lastId };
  }

  resolveMentions(text: string, channelId: string): string[] {
    const uids: string[] = [];
    const seen = new Set<string>();
    const nameMap = this.nameToUidByChannel.get(channelId);
    if (!nameMap) return uids;

    // Match @name where name is a run of word-like characters (letters, digits, underscores,
    // CJK ideographs, Hangul, Kana, etc.) — stops at punctuation and whitespace.
    const regex = /@([\w\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u309f\u30a0-\u30ff]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      // Strip known trailing punctuation that might stick to names
      let name = match[1];
      name = name.replace(/[,.!?;:，。！？；：、)\]]+$/, '');
      if (!name) continue;
      const uid = nameMap.get(name);
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        uids.push(uid);
      }
    }
    return uids;
  }

  getName(uid: string, channelId: string): string | undefined {
    return this.getMemberMap(channelId).get(uid);
  }

  /** G23: Check the server-authoritative robot flag for a group member. */
  isRobot(channelId: string, uid: string): boolean | undefined {
    return this.robotFlags.get(channelId)?.get(uid);
  }

  /**
   * A8 (#143): true iff `uid` is a current member of `channelId` per the cached
   * member list. The list is kept authoritative by refreshMembers (it prunes
   * departed members, not just upserts) — but it is only best-effort fresh:
   * refresh is throttled to REFRESH_INTERVAL_MS and seeded from DB on restart,
   * so a membership change inside that window may not be reflected yet. Used by
   * the outbound mention guard as defense-in-depth (the server still enforces
   * real permissions), NOT as a real-time authority.
   */
  isMember(channelId: string, uid: string): boolean {
    return this.memberMapByChannel.get(channelId)?.has(uid) ?? false;
  }

  /**
   * A8 (#143): the channel's displayName→uid map, for v1 `@name` outbound
   * resolution in StreamRelay.deliver. Returns the live map (empty if the
   * channel has no cached members yet). Read-only use by callers.
   */
  getNameToUidMap(channelId: string): Map<string, string> {
    return this.getNameToUid(channelId);
  }

  loadMembersFromDb(channelId: string): void {
    try {
      const rows = this.selectMembers.all(channelId) as MemberRow[];
      const memberMap = this.getMemberMap(channelId);
      const nameMap = this.getNameToUid(channelId);
      for (const r of rows) {
        if (!r.uid || !r.name) continue;
        memberMap.set(r.uid, r.name);
        nameMap.set(r.name, r.uid);
      }
    } catch (err) {
      console.error(`group-context: loadMembersFromDb(${channelId}) failed: ${String(err)}`);
    }
  }

  loadMessagesFromDb(channelId: string): void {
    try {
      const rows = this.selectRecentMessages.all(channelId, this.maxWindowSize) as Array<{
        from_uid: string;
        from_name: string;
        content: string;
        timestamp: number;
      }>;
      if (rows.length === 0) return;
      // Rows come in DESC order, reverse to chronological
      rows.reverse();
      const existing = this.messageCache.get(channelId);
      if (existing && existing.length > 0) return; // Don't overwrite live data
      // Map snake_case DB columns to camelCase GroupMessage
      this.messageCache.set(channelId, rows.map(r => ({
        fromUid: r.from_uid,
        fromName: r.from_name,
        content: r.content,
        timestamp: r.timestamp,
      })));
    } catch (err) {
      console.error(`group-context: loadMessagesFromDb(${channelId}) failed: ${String(err)}`);
    }
  }

  /** Load all persisted members and messages from DB (call once at startup). */
  loadAllFromDb(): void {
    try {
      const rows = this.adapter.prepare(
        'SELECT DISTINCT group_id FROM group_members',
      ).all() as Array<{ group_id: string }>;
      for (const row of rows) {
        this.loadMembersFromDb(row.group_id);
        this.loadMessagesFromDb(row.group_id);
      }
      if (rows.length > 0) {
        console.log(`[group-context] Loaded members + messages for ${rows.length} group(s) from DB`);
      }
    } catch (err) {
      console.error(`group-context: loadAllFromDb failed: ${String(err)}`);
    }
  }
}
