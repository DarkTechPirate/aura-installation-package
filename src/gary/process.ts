/**
 * Gary child process — reads JSON lines from stdin, writes JSON lines to stdout.
 *
 * Tool execution is proxied back to the parent gateway:
 *   1. Gary sends { type: 'tool_call', id, toolName, args } to stdout
 *   2. Parent executes the real skill tool, sends { type: 'tool_result', id, result } to stdin
 *   3. Gary resolves the pending promise and continues the workflow
 */

// ── IPC safety: redirect all console.log/warn to stderr ──────────────────────
// Gary uses stdout exclusively for JSON-line IPC messages (send() below).
// The logger.ts module uses console.log for info/debug and console.warn for warn,
// which would corrupt the IPC channel if left on stdout.
// Redirect before any module imports that might log during initialisation.
const _toStderr = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');
console.log  = _toStderr;
console.warn = _toStderr;

import readline from 'readline';
import type { ToolCall }     from '../llm/types.js';
import type { SkillContext } from '../skills/types.js';
import { resolveWorkflow }   from '../workflow/workflows.js';
import { runWorkflow }       from '../workflow/runner.js';
import type { WorkflowMatch } from '../workflow/intent.js';
import type { ParentToGary, GaryToParent } from './types.js';

// ── Pending tool call resolvers ───────────────────────────────────────────────
const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

function send(msg: GaryToParent): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Proxied execute — tool calls go to parent, not run locally ────────────────
function execute(call: ToolCall, _ctx: SkillContext, _sessionId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pending.set(call.id, { resolve, reject });
    send({ type: 'tool_call', id: call.id, toolName: call.name, args: call.args });
  });
}

// ── Minimal stub context (unused — tool execution is proxied to parent) ───────
const stubCtx: SkillContext = {
  node_id:    'gary',
  session_id: '',
  agent_id:   'gary',
  anp:        { sendCommand: () => {} },
  memory:     { search: async () => [] },
  channel:    { send: async () => {} },
  canvas:     { append: () => {}, clear: () => {} },
};

// ── Stdin listener ────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  let msg: ParentToGary;
  try {
    msg = JSON.parse(line) as ParentToGary;
  } catch {
    return; // ignore malformed lines
  }

  // ── Tool result from parent ──────────────────────────────────────────────
  if (msg.type === 'tool_result') {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else           p.resolve(msg.result);
    }
    return;
  }

  // ── Run request from parent ──────────────────────────────────────────────
  if (msg.type === 'run') {
    const match: WorkflowMatch = {
      intent:     msg.intent as WorkflowMatch['intent'],
      instrument: msg.instrument,
      side:       msg.side as WorkflowMatch['side'],
      query:      msg.query,
    };

    const def = resolveWorkflow(match);
    if (!def) {
      send({ type: 'result', ok: false, status: 'error', output: `Unknown intent: ${msg.intent}` });
      return;
    }

    stubCtx.session_id = msg.sessionId;

    try {
      const output = await runWorkflow(def, stubCtx, execute, msg.sessionId);
      send({
        type:   'result',
        ok:     true,
        status: def.requiresApproval ? 'needs_approval' : 'ok',
        output,
      });
    } catch (err) {
      send({
        type:   'result',
        ok:     false,
        status: 'error',
        output: err instanceof Error ? err.message : String(err),
      });
    }
  }
});
