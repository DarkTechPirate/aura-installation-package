import fs from 'fs';
import path from 'path';
import { MEMORY_DIR } from '../config/loader.js';

/**
 * Persistent per-agent markdown files for long-term learning:
 *   ~/.aura/memory/<ns>/user_profile.md   — facts about the user
 *   ~/.aura/memory/<ns>/self_knowledge.md — facts the agent learned about itself
 *
 * Plain markdown so it is human-readable and editable.
 */
export class ProfileMemory {
  // mtime-keyed cache so disk is only re-read when the file actually changes
  private fileCache = new Map<string, { content: string; mtime: number }>();

  private readCached(filePath: string): string {
    try {
      const stat = fs.statSync(filePath);
      const hit  = this.fileCache.get(filePath);
      if (hit && hit.mtime === stat.mtimeMs) return hit.content;
      const content = fs.readFileSync(filePath, 'utf8');
      this.fileCache.set(filePath, { content, mtime: stat.mtimeMs });
      return content;
    } catch { return ''; }
  }

  private invalidate(filePath: string): void {
    this.fileCache.delete(filePath);
  }

  private dir(ns: string): string {
    return path.join(MEMORY_DIR, ns);
  }

  private profilePath(ns: string): string {
    return path.join(this.dir(ns), 'user_profile.md');
  }

  private selfPath(ns: string): string {
    return path.join(this.dir(ns), 'self_knowledge.md');
  }

  private ensureDir(ns: string): void {
    const d = this.dir(ns);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  readProfile(ns: string): string {
    return this.readCached(this.profilePath(ns));
  }

  readSelf(ns: string): string {
    return this.readCached(this.selfPath(ns));
  }

  appendToProfile(ns: string, facts: string): void {
    this.ensureDir(ns);
    const fp   = this.profilePath(ns);
    const date = new Date().toISOString().slice(0, 10);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, '# User Profile\n', 'utf8');
    }
    fs.appendFileSync(fp, `\n<!-- ${date} -->\n${facts.trim()}\n`, 'utf8');
    this.invalidate(fp);
  }

  appendToSelf(ns: string, facts: string): void {
    this.ensureDir(ns);
    const fp   = this.selfPath(ns);
    const date = new Date().toISOString().slice(0, 10);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, '# Agent Self-Knowledge\n', 'utf8');
    }
    fs.appendFileSync(fp, `\n<!-- ${date} -->\n${facts.trim()}\n`, 'utf8');
    this.invalidate(fp);
  }

  writeProfile(ns: string, content: string): void {
    this.ensureDir(ns);
    const fp = this.profilePath(ns);
    fs.writeFileSync(fp, content, 'utf8');
    this.invalidate(fp);
  }

  writeSelf(ns: string, content: string): void {
    this.ensureDir(ns);
    const fp = this.selfPath(ns);
    fs.writeFileSync(fp, content, 'utf8');
    this.invalidate(fp);
  }
}
