/**
 * GaryManager — persistent pool of gary child processes.
 *
 * Instead of spawning a new gary per workflow request, the manager maintains
 * N gary workers that stay alive and handle requests sequentially. Requests
 * arriving while all workers are busy are queued and dispatched as workers
 * free up. Crashed workers are automatically restarted with a 1-second backoff.
 *
 * Pool size: GARY_POOL_SIZE env var (default: 2).
 */

import { spawn }  from 'child_process';
import readline   from 'readline';
import path       from 'path';
import { fileURLToPath } from 'url';
import type { ChildProcess } from 'child_process';
import type { ToolCall }     from '../llm/types.js';
import type { SkillContext } from '../skills/types.js';
import type { WorkflowMatch } from '../workflow/intent.js';
import type {
  GaryRunRequest,
  GaryToParent,
  GaryResultMsg,
} from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Gary');

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const GARY_ENTRY = path.resolve(__dirname, '../../gary.ts');
const POOL_SIZE  = parseInt(process.env.GARY_POOL_SIZE ?? '2', 10);
const RESTART_DELAY_MS  = 1_000;
const TOOL_TIMEOUT_MS   = 30_000; // max 30s per tool call — prevents infinite hangs

type ExecuteFn = (call: ToolCall, ctx: SkillContext, sessionId: string) => Promise<unknown>;

export interface GaryResult {
  ok:     boolean;
  status: 'ok' | 'needs_approval' | 'error';
  output: string;
}

interface QueuedRequest {
  match:     WorkflowMatch;
  ctx:       SkillContext;
  execute:   ExecuteFn;
  sessionId: string;
  resolve:   (r: GaryResult) => void;
  reject:    (e: Error) => void;
}

interface GaryWorker {
  id:          number;
  child:       ChildProcess;
  rl:          readline.Interface;
  busy:        boolean;
  // ── Active request state ─────────────────────────────────────────────────
  execute:     ExecuteFn | null;
  ctx:         SkillContext | null;
  sessionId:   string | null;
  onResult:    ((msg: GaryResultMsg) => void) | null;
}

class GaryManager {
  private workers: GaryWorker[] = [];
  private queue:   QueuedRequest[] = [];
  private nextId = 0;
  private started = false;

  /** Start the pool. Called once at gateway startup. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < POOL_SIZE; i++) this.spawnWorker();
    logger.info('Gary pool started', { size: POOL_SIZE });
  }

  /** Run a workflow via an idle gary worker (or queue if all busy). */
  run(
    match:     WorkflowMatch,
    ctx:       SkillContext,
    execute:   ExecuteFn,
    sessionId: string,
  ): Promise<GaryResult> {
    return new Promise((resolve, reject) => {
      const req: QueuedRequest = { match, ctx, execute, sessionId, resolve, reject };
      const idle = this.workers.find(w => !w.busy);
      if (idle) {
        this.dispatch(idle, req);
      } else {
        this.queue.push(req);
        logger.debug('Gary request queued', { queueLength: this.queue.length });
      }
    });
  }

  /** Gracefully shut down all gary workers. */
  shutdown(): void {
    for (const w of this.workers) {
      try { w.child.stdin?.end(); w.child.kill(); } catch { /* ignore */ }
    }
    this.workers = [];
    logger.info('Gary pool shut down');
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private spawnWorker(): void {
    const id = this.nextId++;

    // Reason: use the same node binary + tsx loader flags as the parent so that
    // NVM-managed node (not /usr/bin/env node) is used in the child process.
    const child = spawn(process.execPath, [...process.execArgv, GARY_ENTRY], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env:   process.env,
    });

    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });

    const worker: GaryWorker = {
      id, child, rl,
      busy:      false,
      execute:   null,
      ctx:       null,
      sessionId: null,
      onResult:  null,
    };

    // ── Handle messages from gary stdout ──────────────────────────────────
    rl.on('line', async (line) => {
      let msg: GaryToParent;
      try {
        msg = JSON.parse(line) as GaryToParent;
      } catch {
        logger.warn('Gary non-JSON stdout', { id, line: line.slice(0, 120) });
        return;
      }

      // tool_call — proxy to parent's executeToolCall
      if (msg.type === 'tool_call') {
        if (!worker.execute || !worker.ctx || !worker.sessionId) return;
        try {
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Tool call timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
          );
          const result = await Promise.race([
            worker.execute(
              { id: msg.id, name: msg.toolName, args: msg.args },
              worker.ctx,
              worker.sessionId,
            ),
            timeoutPromise,
          ]);
          child.stdin!.write(JSON.stringify({ type: 'tool_result', id: msg.id, result }) + '\n');
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger.warn('Gary tool call error', { tool: msg.toolName, error });
          child.stdin!.write(JSON.stringify({ type: 'tool_result', id: msg.id, error }) + '\n');
        }
        return;
      }

      // result — workflow complete, free the worker
      if (msg.type === 'result') {
        const cb = worker.onResult;
        this.resetWorker(worker);
        cb?.(msg);
        this.drain();
      }
    });

    child.on('error', (err) => {
      logger.error('Gary worker error', { id, message: err.message });
      this.handleCrash(worker);
    });

    child.on('exit', (code, signal) => {
      if (code !== 0) {
        logger.warn('Gary worker exited unexpectedly', { id, code, signal });
        this.handleCrash(worker);
      }
    });

    this.workers.push(worker);
    logger.debug('Gary worker spawned', { id });
  }

  private dispatch(worker: GaryWorker, req: QueuedRequest): void {
    worker.busy      = true;
    worker.execute   = req.execute;
    worker.ctx       = req.ctx;
    worker.sessionId = req.sessionId;

    worker.onResult = (msg: GaryResultMsg) => {
      req.resolve({ ok: msg.ok, status: msg.status, output: msg.output });
    };

    const runReq: GaryRunRequest = {
      type:       'run',
      intent:     req.match.intent,
      instrument: req.match.instrument,
      side:       req.match.side,
      query:      req.match.query,
      sessionId:  req.sessionId,
    };

    worker.child.stdin!.write(JSON.stringify(runReq) + '\n');
    logger.debug('Gary dispatch', { workerId: worker.id, intent: req.match.intent });
  }

  private resetWorker(worker: GaryWorker): void {
    worker.busy      = false;
    worker.execute   = null;
    worker.ctx       = null;
    worker.sessionId = null;
    worker.onResult  = null;
  }

  private handleCrash(worker: GaryWorker): void {
    // Fail in-flight request if any
    if (worker.onResult) {
      worker.onResult({
        type: 'result', ok: false, status: 'error',
        output: `Gary worker #${worker.id} crashed`,
      });
    }
    this.workers = this.workers.filter(w => w.id !== worker.id);
    // Respawn after backoff
    setTimeout(() => {
      if (this.started) {
        logger.info('Restarting Gary worker', { id: worker.id });
        this.spawnWorker();
        this.drain();
      }
    }, RESTART_DELAY_MS);
  }

  private drain(): void {
    if (this.queue.length === 0) return;
    const idle = this.workers.find(w => !w.busy);
    if (!idle) return;
    const req = this.queue.shift()!;
    this.dispatch(idle, req);
  }
}

/** Singleton gary pool — import and use directly. */
export const gary = new GaryManager();
