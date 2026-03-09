import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MEMORY_DIR } from '../config/loader.js';
import type { CanvasBlock } from './types.js';

const CANVAS_FILE = path.join(MEMORY_DIR, 'canvas.json');

/**
 * Manages the live Canvas state — an ordered list of CanvasBlocks.
 * Persists to ~/.aura/memory/canvas.json on every change.
 */
export class CanvasRenderer {
  private blocks: CanvasBlock[] = [];
  private onChangeCallback: (() => void) | null = null;

  constructor() {
    this.restore();
  }

  private restore(): void {
    try {
      if (fs.existsSync(CANVAS_FILE)) {
        const data = JSON.parse(fs.readFileSync(CANVAS_FILE, 'utf8')) as CanvasBlock[];
        this.blocks = Array.isArray(data) ? data : [];
      }
    } catch {
      this.blocks = [];
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(CANVAS_FILE, JSON.stringify(this.blocks, null, 2), 'utf8');
    } catch (err) {
      console.error('[Canvas] Failed to persist:', err);
    }
    this.onChangeCallback?.();
  }

  onChange(cb: () => void): void {
    this.onChangeCallback = cb;
  }

  append(block: Omit<CanvasBlock, 'id'>): CanvasBlock {
    const id = crypto.randomUUID();
    const newBlock = { id, ...block } as CanvasBlock;
    this.blocks.push(newBlock);
    this.persist();
    return newBlock;
  }

  update(id: string, fields: Partial<CanvasBlock>): void {
    const idx = this.blocks.findIndex(b => b.id === id);
    if (idx === -1) return;
    this.blocks[idx] = { ...this.blocks[idx]!, ...fields, id } as CanvasBlock;
    this.persist();
  }

  delete(id: string): void {
    this.blocks = this.blocks.filter(b => b.id !== id);
    this.persist();
  }

  clear(): void {
    this.blocks = [];
    this.persist();
  }

  getBlocks(): CanvasBlock[] {
    return [...this.blocks];
  }
}
