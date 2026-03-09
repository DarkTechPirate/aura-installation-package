import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';

const dbPath = path.join(os.homedir(), '.aura', 'memory', 'aura.db');

function getDb() {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    fire_at DATETIME NOT NULL,
    target_node TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT 'personal',
    fired INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reminders_fire ON reminders(fire_at, fired)`);
  return db;
}

export async function set_reminder(
  args: { text: string; fire_at_iso: string; target_node?: string },
  ctx: { node_id: string }
): Promise<unknown> {
  const db = getDb();
  const target = args.target_node ?? (ctx as Record<string, unknown>)['node_id'] as string ?? 'unknown';
  db.prepare('INSERT INTO reminders (text, fire_at, target_node) VALUES (?, ?, ?)').run(
    args.text, args.fire_at_iso, target
  );
  db.close();
  return { set: true, text: args.text, fire_at: args.fire_at_iso, target_node: target };
}

export async function list_reminders(_args: unknown, _ctx: unknown): Promise<unknown> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM reminders WHERE fired = 0 ORDER BY fire_at').all();
  db.close();
  return rows;
}

export async function cancel_reminder(args: { id: number }, _ctx: unknown): Promise<unknown> {
  const db = getDb();
  db.prepare('DELETE FROM reminders WHERE id = ?').run(args.id);
  db.close();
  return { cancelled: true, id: args.id };
}
