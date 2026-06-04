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
  private readonly memberMap = new Map<string, string>();
  private readonly nameToUid = new Map<string, string>();
  private readonly lastRefresh = new Map<string, number>();

  private readonly adapter: DbAdapter;
  private readonly maxContextChars: number;
  private readonly maxWindowSize: number;

  private upsertMember!: PreparedStatement;
  private selectMembers!: PreparedStatement;

  constructor(adapter: DbAdapter, maxContextChars: number) {
    this.adapter = adapter;
    this.maxContextChars = maxContextChars;
    this.maxWindowSize = 100;
    this.initStatements();
  }

  private initStatements(): void {
    this.upsertMember = this.adapter.prepare(
      'INSERT INTO group_members (group_id, uid, name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(group_id, uid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at',
    );
    this.selectMembers = this.adapter.prepare(
      'SELECT uid, name FROM group_members WHERE group_id = ?',
    );
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
  }

  learnMember(channelId: string, uid: string, name: string): void {
    if (!uid || !name) return;
    const existing = this.memberMap.get(uid);
    if (existing !== name) {
      this.memberMap.set(uid, name);
      this.nameToUid.set(name, uid);
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
    this.lastRefresh.set(channelId, now);

    try {
      const members = await getGroupMembers({ apiUrl, botToken, groupNo: channelId });
      for (const m of members) {
        if (!m.uid || !m.name) continue;
        this.memberMap.set(m.uid, m.name);
        this.nameToUid.set(m.name, m.uid);
        try {
          this.upsertMember.run(channelId, m.uid, m.name, now);
        } catch (err) {
          console.error(`group-context: upsert member failed: ${String(err)}`);
        }
      }
    } catch (err) {
      console.error(`group-context: refreshMembers(${channelId}) failed: ${String(err)}`);
    }
  }

  async fetchAndLearnUser(uid: string, apiUrl: string, botToken: string): Promise<string | undefined> {
    const cached = this.memberMap.get(uid);
    if (cached) return cached;
    try {
      const info = await fetchUserInfo({ apiUrl, botToken, uid });
      if (info?.name) {
        this.memberMap.set(uid, info.name);
        this.nameToUid.set(info.name, uid);
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

  resolveMentions(text: string): string[] {
    const uids: string[] = [];
    const seen = new Set<string>();
    const regex = /@(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const name = match[1];
      let uid = this.nameToUid.get(name);
      if (!uid) {
        // Try progressively shorter prefixes — handles trailing punctuation.
        for (let end = name.length - 1; end > 0 && !uid; end--) {
          uid = this.nameToUid.get(name.slice(0, end));
        }
      }
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        uids.push(uid);
      }
    }
    return uids;
  }

  getName(uid: string): string | undefined {
    return this.memberMap.get(uid);
  }

  loadMembersFromDb(channelId: string): void {
    try {
      const rows = this.selectMembers.all(channelId) as MemberRow[];
      for (const r of rows) {
        if (!r.uid || !r.name) continue;
        this.memberMap.set(r.uid, r.name);
        this.nameToUid.set(r.name, r.uid);
      }
    } catch (err) {
      console.error(`group-context: loadMembersFromDb(${channelId}) failed: ${String(err)}`);
    }
  }
}
