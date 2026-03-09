import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_PATH = path.join(os.homedir(), '.aura', 'logs', 'audit.jsonl');

function ensureLogDir(): void {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function write(entry: Record<string, unknown>): void {
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* never crash on audit failure */ }
}

export const audit = {
  llmCall(nodeId: string, agentId: string, tier: string, model: string): void {
    write({ event: 'llm_call', node_id: nodeId, agent_id: agentId, tier, model });
  },
  toolCall(nodeId: string, agentId: string, toolName: string, argsSummary: string): void {
    write({ event: 'tool_call', node_id: nodeId, agent_id: agentId, tool: toolName, args: argsSummary });
  },
  toolResult(nodeId: string, toolName: string, ok: boolean, durationMs: number): void {
    write({ event: 'tool_result', node_id: nodeId, tool: toolName, ok, duration_ms: durationMs });
  },
  rateLimited(nodeId: string, waitSecs: number): void {
    write({ event: 'rate_limited', node_id: nodeId, wait_secs: waitSecs });
  },
  secretRedacted(nodeId: string, count: number): void {
    write({ event: 'secret_redacted', node_id: nodeId, patterns_found: count });
  },
};
