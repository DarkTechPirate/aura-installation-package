/**
 * spawnGary() — launches the gary child process and drives the JSON-line protocol.
 *
 * The gateway (parent) spawns gary, sends a run request, then proxies tool calls
 * back through its own executeToolCall function. Gary assembles the result and
 * returns it as a GaryResultMsg. The child process exits when done.
 */

import { spawn }  from 'child_process';
import path       from 'path';
import readline   from 'readline';
import { fileURLToPath } from 'url';
import type { ToolCall }     from '../llm/types.js';
import type { SkillContext } from '../skills/types.js';
import type { WorkflowMatch } from '../workflow/intent.js';
import type { GaryRunRequest, GaryToParent, GaryResultMsg } from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Gary');

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const GARY_ENTRY = path.resolve(__dirname, '../../gary.ts');

type ExecuteFn = (call: ToolCall, ctx: SkillContext, sessionId: string) => Promise<unknown>;

export interface GaryResult {
  ok:     boolean;
  status: 'ok' | 'needs_approval' | 'error';
  output: string;
}

export function spawnGary(
  match:     WorkflowMatch,
  ctx:       SkillContext,
  execute:   ExecuteFn,
  sessionId: string,
): Promise<GaryResult> {
  return new Promise((resolve, reject) => {
    // Reason: use the same node binary + tsx loader flags as the parent so that
    // NVM-managed node (not /usr/bin/env node) is used in the child process.
    const child = spawn(process.execPath, [...process.execArgv, GARY_ENTRY], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env:   process.env,
    });

    // ── Read gary's stdout line by line ─────────────────────────────────────
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });

    rl.on('line', async (line) => {
      let msg: GaryToParent;
      try {
        msg = JSON.parse(line) as GaryToParent;
      } catch {
        logger.warn('Gary sent non-JSON line', { line });
        return;
      }

      if (msg.type === 'tool_call') {
        // ── Proxy tool call to parent's executeToolCall ────────────────────
        try {
          const result = await execute(
            { id: msg.id, name: msg.toolName, args: msg.args },
            ctx,
            sessionId,
          );
          child.stdin!.write(JSON.stringify({ type: 'tool_result', id: msg.id, result }) + '\n');
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          child.stdin!.write(JSON.stringify({ type: 'tool_result', id: msg.id, error }) + '\n');
        }
        return;
      }

      if (msg.type === 'result') {
        // ── Gary is done — close stdin and resolve ─────────────────────────
        child.stdin!.end();
        resolve(msg as GaryResultMsg);
      }
    });

    child.on('error', (err) => {
      logger.error('Gary spawn error', { message: err.message });
      reject(err);
    });

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Gary exited with code ${code}`));
      }
    });

    // ── Send run request ─────────────────────────────────────────────────────
    const req: GaryRunRequest = {
      type:       'run',
      intent:     match.intent,
      instrument: match.instrument,
      side:       match.side,
      query:      match.query,
      sessionId,
    };
    child.stdin!.write(JSON.stringify(req) + '\n');
  });
}
