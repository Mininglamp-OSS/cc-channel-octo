/**
 * Session Store — SQLite persistence via better-sqlite3 + thin adapter.
 */

import type { DbAdapter, PreparedStatement } from './db-adapter.js';

export interface Session {
  id: string;
  channelId: string;
  channelType: number;
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  id: string;
  channel_id: string;
  channel_type: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  role: 'user' | 'assistant';
  content: string;
  message_seq: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  channel_type INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  message_seq INTEGER,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);
`;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelType: row.channel_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SessionStore {
  private readonly adapter: DbAdapter;

  private selectSession!: PreparedStatement;
  private insertSession!: PreparedStatement;
  private touchSession!: PreparedStatement;
  private insertMessage!: PreparedStatement;
  private selectRecentMessages!: PreparedStatement;
  private deleteExpired!: PreparedStatement;
  private deleteSessionStmt!: PreparedStatement;

  /** Tracks the last message_seq at which the bot replied, per group session key. */
  private lastBotReplySeq = new Map<string, number>();

  constructor(adapter: DbAdapter) {
    this.adapter = adapter;
  }

  init(): void {
    this.adapter.exec(SCHEMA);

    // Migration: add message_seq column if missing (for DBs created before G10).
    try {
      const cols = this.adapter
        .prepare("PRAGMA table_info(messages)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'message_seq')) {
        this.adapter.exec('ALTER TABLE messages ADD COLUMN message_seq INTEGER');
      }
    } catch (err) {
      console.warn(`session-store: migration check failed: ${String(err)}`);
    }

    this.selectSession = this.adapter.prepare('SELECT * FROM sessions WHERE id = ?');
    this.insertSession = this.adapter.prepare(
      'INSERT INTO sessions (id, channel_id, channel_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.touchSession = this.adapter.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
    this.insertMessage = this.adapter.prepare(
      'INSERT INTO messages (session_id, role, content, timestamp, message_seq) VALUES (?, ?, ?, ?, ?)',
    );
    this.selectRecentMessages = this.adapter.prepare(
      'SELECT role, content, message_seq FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    );
    this.deleteExpired = this.adapter.prepare('DELETE FROM sessions WHERE updated_at < ?');
    this.deleteSessionStmt = this.adapter.prepare('DELETE FROM sessions WHERE id = ?');
  }

  getOrCreate(id: string, channelId: string, channelType: number): Session {
    const now = Date.now();
    const existing = this.selectSession.get(id) as SessionRow | undefined;
    if (existing) {
      this.touchSession.run(now, id);
      return rowToSession({ ...existing, updated_at: now });
    }
    this.insertSession.run(id, channelId, channelType, now, now);
    return {
      id,
      channelId,
      channelType,
      createdAt: now,
      updatedAt: now,
    };
  }

  appendUser(sessionId: string, content: string, messageSeq?: number): void {
    this.append(sessionId, 'user', content, messageSeq);
  }

  appendAssistant(sessionId: string, content: string, messageSeq?: number): void {
    this.append(sessionId, 'assistant', content, messageSeq);
  }

  private append(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    messageSeq?: number,
  ): void {
    const now = Date.now();
    this.insertMessage.run(sessionId, role, content, now, messageSeq ?? null);
    this.touchSession.run(now, sessionId);
  }

  buildHistoryPrefix(sessionId: string, limit: number): string {
    const rows = this.selectRecentMessages.all(sessionId, limit) as MessageRow[];
    // Rows are DESC; reverse to chronological order.
    const ordered = rows.slice().reverse();
    return ordered.map((r) => `[${r.role}]: ${r.content}`).join('\n');
  }

  cleanExpired(): number {
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    const result = this.deleteExpired.run(cutoff);
    return result.changes;
  }

  deleteSession(sessionId: string): void {
    this.deleteSessionStmt.run(sessionId);
  }

  close(): void {
    this.adapter.close();
  }

  /** Record the message_seq at which the bot last replied for a session. */
  setLastBotReplySeq(sessionId: string, seq: number): void {
    this.lastBotReplySeq.set(sessionId, seq);
  }

  /** Get the message_seq at which the bot last replied for a session. */
  getLastBotReplySeq(sessionId: string): number | undefined {
    return this.lastBotReplySeq.get(sessionId);
  }

  /**
   * Build history prefix with answered/new segmentation (G10).
   * Messages with message_seq <= lastBotReplySeq are labeled [answered history],
   * messages after are labeled [new messages]. Falls back to flat history if
   * no lastBotReplySeq tracked or no seq data available.
   */
  buildSegmentedHistoryPrefix(sessionId: string, limit: number): string {
    const rows = this.selectRecentMessages.all(sessionId, limit) as MessageRow[];
    const ordered = rows.slice().reverse();
    if (ordered.length === 0) return '';

    const lastReplySeq = this.lastBotReplySeq.get(sessionId);
    if (lastReplySeq === undefined) {
      // No segmentation tracking — return flat history.
      return ordered.map((r) => `[${r.role}]: ${r.content}`).join('\n');
    }

    // Real segmentation by message_seq (G10 fix per PR#30 review):
    // - rows with message_seq <= lastReplySeq are answered
    // - rows with message_seq > lastReplySeq are new
    // - rows with NULL message_seq (assistant replies, legacy) attach to the
    //   answered side if they precede any "new" user row, else stay flat.
    const answered: MessageRow[] = [];
    const newMsgs: MessageRow[] = [];
    let seenNew = false;
    for (const r of ordered) {
      if (r.message_seq != null && r.message_seq > lastReplySeq) {
        seenNew = true;
        newMsgs.push(r);
      } else if (r.message_seq != null) {
        answered.push(r);
      } else {
        // No seq (e.g. assistant reply) — follows the current side.
        (seenNew ? newMsgs : answered).push(r);
      }
    }

    if (newMsgs.length === 0) {
      // Nothing new since last reply — don't show segmentation labels.
      return answered.map((r) => `[${r.role}]: ${r.content}`).join('\n');
    }

    const parts: string[] = [];
    if (answered.length > 0) {
      parts.push('[answered history]');
      parts.push(...answered.map((r) => `[${r.role}]: ${r.content}`));
    }
    parts.push('[new messages]');
    parts.push(...newMsgs.map((r) => `[${r.role}]: ${r.content}`));
    return parts.join('\n');
  }
}
