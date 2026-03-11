/**
 * WorkflowLoader — file-based workflow definitions (OpenClaw plugin-discovery parity).
 *
 * Loads ~/.aura/workflows/*.yaml at startup and hot-reloads on change.
 * File-loaded workflows override built-in switch/case definitions (same intent name).
 *
 * YAML schema:
 *   intent, description, parallel, allowTools, requiresApproval, failFast,
 *   patterns (regex strings for intent detection),
 *   steps (same shape as WorkflowStep), llmInstruction
 *
 * $match.* in step args are substituted at resolve-time from the WorkflowMatch:
 *   $match.query, $match.instrument, $match.side
 */

import fs   from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';
import chokidar from 'chokidar';
import { AURA_DIR }    from '../config/loader.js';
import { createLogger } from '../logger.js';
import type { WorkflowDef, WorkflowStep } from './workflows.js';
import type { WorkflowMatch } from './intent.js';

const logger = createLogger('WorkflowLoader');

export const WORKFLOWS_DIR = path.join(AURA_DIR, 'intents');

// ── YAML schema ───────────────────────────────────────────────────────────────

const StepSchema = z.object({
  id:          z.string().optional(),
  toolName:    z.string().optional(),
  subWorkflow: z.string().optional(),
  args:        z.record(z.string(), z.unknown()).default({}),
  condition:   z.string().optional(),
  loop:        z.object({ maxIterations: z.number(), condition: z.string() }).optional(),
  approval:    z.literal('required').optional(),
});

const WorkflowFileSchema = z.object({
  intent:           z.string().min(1),
  description:      z.string().default(''),
  parallel:         z.boolean().default(false),
  allowTools:       z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
  failFast:         z.boolean().default(false),
  patterns:         z.array(z.string()).default([]),
  steps:            z.array(StepSchema).min(1),
  llmInstruction:   z.string().default(''),
});

type WorkflowFile = z.infer<typeof WorkflowFileSchema>;

// ── Stored entry (workflow + compiled patterns) ───────────────────────────────

interface LoadedWorkflow {
  def:      WorkflowDef;
  patterns: RegExp[];
}

// ── $match.* substitution ─────────────────────────────────────────────────────

function substituteMatch(def: WorkflowDef, match: WorkflowMatch): WorkflowDef {
  const vars: Record<string, string> = {
    query:      match.query      ?? '',
    instrument: match.instrument ?? '',
    side:       match.side       ?? '',
  };
  const steps = def.steps.map(step => ({
    ...step,
    args: Object.fromEntries(
      Object.entries(step.args).map(([k, v]) => {
        if (typeof v === 'string' && v.startsWith('$match.')) {
          return [k, vars[v.slice(7)] ?? v];
        }
        return [k, v];
      })
    ),
  }));
  return { ...def, steps };
}

// ── WorkflowLoader ────────────────────────────────────────────────────────────

export class WorkflowLoader {
  private loaded      = new Map<string, LoadedWorkflow>(); // intent → entry
  private fileToIntent = new Map<string, string>();         // filePath → intent
  private watcher:    ReturnType<typeof chokidar.watch> | null = null;
  private onChange:   (() => void) | null = null;

  onChanged(cb: () => void): void { this.onChange = cb; }

  async load(): Promise<void> {
    if (!fs.existsSync(WORKFLOWS_DIR)) {
      fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
      logger.info('Created workflows directory', { path: WORKFLOWS_DIR });
      return;
    }
    const files = fs.readdirSync(WORKFLOWS_DIR)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      this.loadFile(path.join(WORKFLOWS_DIR, file));
    }
    logger.info('Workflows loaded', { count: this.loaded.size });
  }

  watch(): void {
    this.watcher = chokidar.watch(WORKFLOWS_DIR, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300 },
    });
    this.watcher
      .on('add',    p => { this.loadFile(p);   this.onChange?.(); })
      .on('change', p => { this.loadFile(p);   this.onChange?.(); })
      .on('unlink', p => { this.unloadFile(p); this.onChange?.(); });
    logger.info('Watching workflows directory', { path: WORKFLOWS_DIR });
  }

  /** Detect an intent from user text using file-loaded patterns (after built-ins). */
  detectIntent(text: string): WorkflowMatch | null {
    for (const [intent, entry] of this.loaded) {
      for (const re of entry.patterns) {
        if (re.test(text)) {
          return { intent: intent as WorkflowMatch['intent'] };
        }
      }
    }
    return null;
  }

  /**
   * Resolve a WorkflowDef for the given intent.
   * Returns null if no file-loaded workflow matches — caller falls through to built-ins.
   */
  resolve(match: WorkflowMatch): WorkflowDef | null {
    const entry = this.loaded.get(match.intent);
    if (!entry) return null;
    return substituteMatch(entry.def, match);
  }

  listWorkflows(): Array<{ intent: string; description: string; patternCount: number }> {
    return Array.from(this.loaded.entries()).map(([intent, e]) => ({
      intent,
      description: e.def.llmInstruction.slice(0, 80),
      patternCount: e.patterns.length,
    }));
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private loadFile(filePath: string): void {
    if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) return;
    try {
      const raw    = fs.readFileSync(filePath, 'utf8');
      const parsed = WorkflowFileSchema.parse(yaml.load(raw));
      const def    = this.toWorkflowDef(parsed);
      const patterns = parsed.patterns.map(p => {
        try   { return new RegExp(p, 'i'); }
        catch { logger.warn(`Bad regex in ${path.basename(filePath)}: ${p}`); return null; }
      }).filter((r): r is RegExp => r !== null);

      this.loaded.set(parsed.intent, { def, patterns });
      this.fileToIntent.set(filePath, parsed.intent);
      logger.info('Workflow loaded', { intent: parsed.intent, file: path.basename(filePath) });
    } catch (err) {
      logger.warn('Invalid workflow file', { file: path.basename(filePath), error: String(err) });
    }
  }

  private unloadFile(filePath: string): void {
    const intent = this.fileToIntent.get(filePath);
    if (intent) {
      this.loaded.delete(intent);
      this.fileToIntent.delete(filePath);
      logger.info('Workflow unloaded', { intent });
    }
  }

  private toWorkflowDef(f: WorkflowFile): WorkflowDef {
    return {
      intent:           f.intent,
      parallel:         f.parallel,
      allowTools:       f.allowTools,
      requiresApproval: f.requiresApproval || undefined,
      failFast:         f.failFast         || undefined,
      steps:            f.steps as WorkflowStep[],
      llmInstruction:   f.llmInstruction,
    };
  }
}

export const workflowLoader = new WorkflowLoader();
