import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';

const dbPath = path.join(os.homedir(), '.aura', 'memory', 'aura.db');

function getDb() {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    payload TEXT NOT NULL,
    processed INTEGER DEFAULT 0,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  return db;
}

export async function webhook_send(
  args: { url: string; payload: unknown; method?: string },
  _ctx: unknown
): Promise<unknown> {
  const method = args.method ?? 'POST';
  const res = await fetch(args.url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args.payload),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.text();
  return { status: res.status, body };
}

export async function webhook_list_received(
  args: { key: string; limit?: number },
  _ctx: unknown
): Promise<unknown> {
  const db = getDb();
  const limit = args.limit ?? 20;
  const rows = db.prepare(
    'SELECT id, payload, received_at FROM webhooks WHERE key = ? ORDER BY received_at DESC LIMIT ?'
  ).all(args.key, limit);
  db.close();
  return rows;
}

export async function webhook_clear(args: { key: string }, _ctx: unknown): Promise<unknown> {
  const db = getDb();
  const info = db.prepare('DELETE FROM webhooks WHERE key = ?').run(args.key);
  db.close();
  return { cleared: info.changes };
}
