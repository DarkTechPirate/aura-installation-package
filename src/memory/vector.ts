import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { MEMORY_DIR } from '../config/loader.js';

const DB_PATH = path.join(MEMORY_DIR, 'vectors.db');
const MODEL   = 'Xenova/all-MiniLM-L6-v2';

// Lazily-typed pipeline to avoid importing at module level (slow cold start)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EmbedPipeline = (text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>;

interface SkillEntry { name: string; embedding: Float32Array }

/**
 * Vector memory — stores conversation summaries as dense embeddings in SQLite.
 * Uses Transformers.js (all-MiniLM-L6-v2, 23 MB) so no API key or network call
 * is needed after the model is downloaded once.
 *
 * Cosine similarity is computed in pure JS. For the expected dataset size
 * (hundreds to low thousands of entries) this is fast enough (~1–5 ms).
 */
export class VectorMemory {
  private db:         Database.Database;
  private pipe:       EmbedPipeline | null = null;
  private skillIndex: SkillEntry[] = [];

  constructor() {
    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,
        date       TEXT NOT NULL,
        content    TEXT NOT NULL,
        embedding  BLOB NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_mv_agent ON memory_vectors(agent_id);
    `);
  }

  /** Warm up the model on startup so the first message isn't slow. */
  async warmup(): Promise<void> {
    try {
      await this.getPipeline();
      console.log('[VectorMemory] Embedding model ready');
    } catch (err) {
      console.warn('[VectorMemory] warmup failed (vector search unavailable):', err instanceof Error ? err.message : err);
    }
  }

  private async getPipeline(): Promise<EmbedPipeline> {
    if (this.pipe) return this.pipe;
    // Dynamic import — avoids slow startup when not used
    const { pipeline, env } = await import('@xenova/transformers');
    // Use the Hugging Face CDN cache (~/.cache/huggingface)
    env.allowLocalModels = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.pipe = await pipeline('feature-extraction', MODEL) as any;
    return this.pipe!;
  }

  private async embed(text: string): Promise<Float32Array> {
    const pipe = await this.getPipeline();
    const out  = await pipe(text, { pooling: 'mean', normalize: true });
    return out.data;
  }

  private cosineSim(a: Float32Array, b: Float32Array): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na  += a[i] * a[i];
      nb  += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  /** Embed and persist a memory entry. Skips near-duplicates (cos sim > 0.95). Fire-and-forget safe. */
  async index(agent_ns: string, date: string, content: string): Promise<void> {
    try {
      const vec = await this.embed(content);

      // Dedup: check the 50 most recent entries for near-identical content
      const recent = this.db.prepare(
        'SELECT embedding FROM memory_vectors WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50'
      ).all(agent_ns) as Array<{ embedding: Buffer }>;

      for (const r of recent) {
        const existing = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
        if (this.cosineSim(vec, existing) > 0.95) {
          console.debug('[VectorMemory] Skipping near-duplicate entry');
          return;
        }
      }

      const blob = Buffer.from(vec.buffer);
      this.db.prepare(
        'INSERT INTO memory_vectors (agent_id, date, content, embedding) VALUES (?, ?, ?, ?)'
      ).run(agent_ns, date, content, blob);
    } catch (err) {
      console.debug('[VectorMemory] index error:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Find the most semantically similar stored memories for a query.
   * Scans the 200 most recent entries for this agent, filters by a minimum
   * similarity threshold, and returns the top `limit` results.
   */
  async search(agent_ns: string, query: string, limit = 5): Promise<string[]> {
    try {
      const qvec = await this.embed(query);
      const rows = this.db.prepare(
        'SELECT content, embedding FROM memory_vectors WHERE agent_id = ? ORDER BY created_at DESC LIMIT 500'
      ).all(agent_ns) as Array<{ content: string; embedding: Buffer }>;

      return rows
        .map(r => {
          const vec   = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
          const score = this.cosineSim(qvec, vec);
          return { content: r.content, score };
        })
        .filter(r => r.score > 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(r => r.content);
    } catch (err) {
      console.debug('[VectorMemory] search error:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  /**
   * Build an in-memory vector index of skill names + descriptions.
   * Call this at startup and whenever skills are added/changed.
   */
  async indexSkills(skills: Array<{ name: string; description: string }>): Promise<void> {
    try {
      const indexed: SkillEntry[] = [];
      for (const s of skills) {
        const text = `${s.name}: ${s.description.slice(0, 300)}`;
        const vec  = await this.embed(text);
        indexed.push({ name: s.name, embedding: vec });
      }
      this.skillIndex = indexed;
      console.log(`[VectorMemory] Indexed ${indexed.length} skills`);
    } catch (err) {
      console.warn('[VectorMemory] indexSkills error:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Find the most semantically relevant skills for a given message.
   * Returns skill names sorted by similarity, filtered by threshold.
   */
  async searchSkills(query: string, limit = 5, threshold = 0.15): Promise<string[]> {
    if (this.skillIndex.length === 0) return [];
    try {
      const qvec   = await this.embed(query);
      const scored = this.skillIndex
        .map(s => ({ name: s.name, score: this.cosineSim(qvec, s.embedding) }))
        .sort((a, b) => b.score - a.score);
      // Log top-3 scores to help tune threshold
      console.debug(`[VectorMemory] top scores: ${scored.slice(0, 3).map(s => `${s.name}=${s.score.toFixed(3)}`).join(', ')}`);
      return scored
        .filter(s => s.score > threshold)
        .slice(0, limit)
        .map(s => s.name);
    } catch (err) {
      console.debug('[VectorMemory] searchSkills error:', err instanceof Error ? err.message : err);
      return [];
    }
  }
}
