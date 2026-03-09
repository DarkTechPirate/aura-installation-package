import fs from 'fs';
import path from 'path';
import { MEMORY_DIR } from '../config/loader.js';

/**
 * Daily episodic memory stored as Markdown files.
 * Location: ~/.aura/memory/<agent_ns>/YYYY-MM-DD.md
 */
export class EpisodicMemory {
  private dir(agent_ns: string): string {
    return path.join(MEMORY_DIR, agent_ns);
  }

  private filePath(agent_ns: string, date: string): string {
    return path.join(this.dir(agent_ns), `${date}.md`);
  }

  async write(agent_ns: string, date: string, content: string): Promise<void> {
    const dir = this.dir(agent_ns);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath(agent_ns, date), content, 'utf8');
  }

  async read(agent_ns: string, date: string): Promise<string> {
    const fp = this.filePath(agent_ns, date);
    if (!fs.existsSync(fp)) return '';
    return fs.readFileSync(fp, 'utf8');
  }

  async delete(agent_ns: string, date: string): Promise<void> {
    const fp = this.filePath(agent_ns, date);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  /** Append a single line to today's episodic file (creates it if absent). */
  append(agent_ns: string, date: string, line: string): void {
    const dir = this.dir(agent_ns);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fp = this.filePath(agent_ns, date);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, `# Episodic Memory — ${date}\n\n`, 'utf8');
    }
    fs.appendFileSync(fp, line + '\n', 'utf8');
  }
}
