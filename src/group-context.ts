/**
 * Group Context — group chat message cache + maxContextChars budget + mention mapping.
 */

import type { DbAdapter, PreparedStatement } from './db-adapter.js';
import { getGroupMembers, fetchUserInfo } from './octo/api.js';

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
  private selectMembers!: PreparedStatement;
  private insertMessage!: PreparedStatement;
  private selectRecentMessages!: PreparedStatement;
  private deleteOldMessages!: PreparedStatement;

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

    this.upsertMember = this.adapter.prepare(
      'INSERT INTO group_members (group_id, uid, name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(group_id, uid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at',
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
    let window = this.messageCache.get(channelId);
    if (!window) {
      window = [];
      this.messageCache.set(channelId, window);
    }
    window.push({ fromUid, fromName, content, timestamp });
    while (window.length > this.maxWindowSize) {
      window.shift();
    }
    this.learnMember(channelId, fromUid, fromName);

    try {
      this.insertMessage.run(channelId, fromUid, fromName, content, timestamp);
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
      const members = await getGroupMembers({ apiUrl, botToken, groupNo: channelId });
      this.lastRefresh.set(channelId, now); // Record only on success
      const memberMap = this.getMemberMap(channelId);
      const nameMap = this.getNameToUid(channelId);
      for (const m of members) {
        if (!m.uid || !m.name) continue;
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
