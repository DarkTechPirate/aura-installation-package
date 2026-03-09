import Database from 'better-sqlite3';
import { MEMORY_DIR } from '../config/loader.js';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(MEMORY_DIR, 'aura.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    fire_at     DATETIME NOT NULL,
    target_node TEXT NOT NULL,
    agent_id    TEXT NOT NULL DEFAULT 'personal',
    fired       INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reminders_fire ON reminders(fire_at, fired);

CREATE TABLE IF NOT EXISTS webhooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT NOT NULL,
    payload     TEXT NOT NULL,
    processed   INTEGER DEFAULT 0,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhooks_key ON webhooks(key, processed);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    date,
    agent_id,
    content,
    tokenize = 'porter ascii'
);
`;

export interface ReminderRow {
  id: number;
  text: string;
  fire_at: string;
  target_node: string;
  agent_id: string;
  fired: number;
}

export interface WebhookRow {
  id: number;
  payload: string;
  received_at: string;
}

/**
 * SQLite-backed semantic memory and persistent data store.
 * Uses FTS5 for full-text memory search, plus reminders and webhooks tables.
 */
export class SemanticMemory {
  private db: Database.Database;

  constructor() {
    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(SCHEMA);
  }

  // ── FTS5 Memory ──────────────────────────────────────────────────────────

  index(agent_ns: string, date: string, content: string): void {
    // Delete existing entry for same agent/date then re-insert
    this.db.prepare('DELETE FROM memory_fts WHERE agent_id = ? AND date = ?').run(agent_ns, date);
    this.db.prepare('INSERT INTO memory_fts (date, agent_id, content) VALUES (?, ?, ?)').run(date, agent_ns, content);
  }

  search(agent_ns: string, query: string, limit = 10): string[] {
    try {
      const rows = this.db.prepare(
        'SELECT content FROM memory_fts WHERE agent_id = ? AND memory_fts MATCH ? ORDER BY rank LIMIT ?'
      ).all(agent_ns, query, limit) as Array<{ content: string }>;
      return rows.map(r => r.content);
    } catch {
      return [];
    }
  }

  // ── Reminders ────────────────────────────────────────────────────────────

  storeReminder(text: string, fire_at: string, target_node: string, agent_id: string): number {
    const result = this.db.prepare(
      'INSERT INTO reminders (text, fire_at, target_node, agent_id) VALUES (?, ?, ?, ?)'
    ).run(text, fire_at, target_node, agent_id);
    return result.lastInsertRowid as number;
  }

  getPendingReminders(now: string): Array<Omit<ReminderRow, 'fired'>> {
    return this.db.prepare(
      'SELECT id, text, fire_at, target_node, agent_id FROM reminders WHERE fired = 0 AND fire_at <= ? ORDER BY fire_at'
    ).all(now) as Array<Omit<ReminderRow, 'fired'>>;
  }

  markReminderFired(id: number): void {
    this.db.prepare('UPDATE reminders SET fired = 1 WHERE id = ?').run(id);
  }

  listReminders(): ReminderRow[] {
    return this.db.prepare(
      'SELECT id, text, fire_at, target_node, agent_id, fired FROM reminders ORDER BY fire_at'
    ).all() as ReminderRow[];
  }

  cancelReminder(id: number): void {
    this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────

  storeWebhook(key: string, payload: string): void {
    this.db.prepare('INSERT INTO webhooks (key, payload) VALUES (?, ?)').run(key, payload);
  }

  getWebhooks(key: string, limit = 50): WebhookRow[] {
    return this.db.prepare(
      'SELECT id, payload, received_at FROM webhooks WHERE key = ? ORDER BY received_at DESC LIMIT ?'
    ).all(key, limit) as WebhookRow[];
  }

  deleteWebhooks(key: string): void {
    this.db.prepare('DELETE FROM webhooks WHERE key = ?').run(key);
  }

  close(): void {
    this.db.close();
  }
}
