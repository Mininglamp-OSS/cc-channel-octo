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
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(group_id, uid)
);
`;

const DEFAULT_HISTORY_LIMIT = 40;
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

  constructor(adapter: DbAdapter) {
    this.adapter = adapter;
  }

  init(): void {
    this.adapter.exec(SCHEMA);

    this.selectSession = this.adapter.prepare('SELECT * FROM sessions WHERE id = ?');
    this.insertSession = this.adapter.prepare(
      'INSERT INTO sessions (id, channel_id, channel_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.touchSession = this.adapter.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
    this.insertMessage = this.adapter.prepare(
      'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
    );
    this.selectRecentMessages = this.adapter.prepare(
      'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
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

  appendUser(sessionId: string, content: string): void {
    this.append(sessionId, 'user', content);
  }

  appendAssistant(sessionId: string, content: string): void {
    this.append(sessionId, 'assistant', content);
  }

  private append(sessionId: string, role: 'user' | 'assistant', content: string): void {
    const now = Date.now();
    this.insertMessage.run(sessionId, role, content, now);
    this.touchSession.run(now, sessionId);
  }

  buildHistoryPrefix(sessionId: string, limit: number = DEFAULT_HISTORY_LIMIT): string {
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
}
