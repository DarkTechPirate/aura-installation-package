/**
 * Inter-agent message bus and comms tool definitions for the orchestrator.
 */

import type { ToolDefinition } from '../llm/types.js';
import { createLogger }         from '../logger.js';

const logger = createLogger('Orchestrator');

// ── Dashboard notifications ───────────────────────────────────────────────────

export function notifyDashboard4(type: string, data: Record<string, unknown>): void {
  fetch('http://localhost:3002/dashboard4/api/event', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, data, ts: Date.now() }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

// ── Message bus ───────────────────────────────────────────────────────────────

export interface AgentMessage { from: string; to: string; content: string; ts: number; }
export const messageBus = new Map<string, AgentMessage[]>();

export function busPost(sessionId: string, from: string, to: string, content: string): void {
  const msgs = messageBus.get(sessionId) ?? [];
  msgs.push({ from, to, content, ts: Date.now() });
  messageBus.set(sessionId, msgs);
  logger.debug('Agent message', { session_id: sessionId, from, to, preview: content.slice(0, 80) });
  notifyDashboard4('agent_message', { session_id: sessionId, from, to, content, ts: Date.now() });
}

export function busRead(sessionId: string, role: string): AgentMessage[] {
  return (messageBus.get(sessionId) ?? []).filter(m => m.to === role || m.to === 'all');
}

// ── Built-in comms tools injected into every sub-agent ────────────────────────

export const COMMS_TOOLS: ToolDefinition[] = [
  {
    name: 'agent_send',
    description: 'Send a message to another agent (or "all") in this team. Use to share findings, ask for data, or coordinate.',
    parameters: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient role, or "all" to broadcast' },
        message: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'agent_read',
    description: 'Read messages sent to you by other agents in this team session.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'pause_for_input',
    description: 'Pause your work, send a message to the user, and wait for their reply before continuing.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to send to the user while pausing' },
      },
      required: ['message'],
    },
  },
];
