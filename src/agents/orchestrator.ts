import crypto from 'crypto';
import type { LLMRouter } from '../llm/router.js';
import type { SkillsEngine } from '../skills/engine.js';
import type { GatewayConfig } from '../config/loader.js';
import type { LLMMessage, ToolDefinition } from '../llm/types.js';
import type { SkillContext } from '../skills/types.js';

interface SubAgentSpec {
  role:   string;
  task:   string;
  tools?: string[];
}

interface SubAgentRun {
  id:         string;
  role:       string;
  task:       string;
  status:     'running' | 'done' | 'error';
  result?:    string;
  error?:     string;
  started_at: number;
  done_at?:   number;
}

interface OrchestratorSession {
  id:         string;
  node_id:    string;
  objective:  string;
  agents:     SubAgentRun[];
  created_at: number;
  status:     'running' | 'done';
}

// ── Live dashboard notifications ──────────────────────────────────────────────
function notifyDashboard4(type: string, data: Record<string, unknown>): void {
  fetch('http://localhost:3002/dashboard4/api/event', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ type, data, ts: Date.now() }),
    signal:  AbortSignal.timeout(2000),
  }).catch(() => { /* non-critical */ });
}

// ── Inter-agent message bus ───────────────────────────────────────────────────
interface AgentMessage {
  from:    string;
  to:      string;
  content: string;
  ts:      number;
}

const messageBus = new Map<string, AgentMessage[]>();

function busPost(sessionId: string, from: string, to: string, content: string): void {
  const msgs = messageBus.get(sessionId) ?? [];
  msgs.push({ from, to, content, ts: Date.now() });
  messageBus.set(sessionId, msgs);
  console.log(`[Orchestrator] ${from} → ${to}: ${content.slice(0, 80)}`);
  notifyDashboard4('agent_message', { session_id: sessionId, from, to, content, ts: Date.now() });
}

function busRead(sessionId: string, role: string): AgentMessage[] {
  return (messageBus.get(sessionId) ?? []).filter(m => m.to === role || m.to === 'all');
}

// ── Built-in comms tools (injected into every sub-agent) ─────────────────────
const COMMS_TOOLS: ToolDefinition[] = [
  {
    name: 'agent_send',
    description: 'Send a message to another agent (or all agents) in this team. Use to share findings, ask for data, or coordinate work.',
    parameters: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Role of the recipient agent, or "all" to broadcast to everyone' },
        message: { type: 'string', description: 'The message content to send' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'agent_read',
    description: 'Read messages sent to you by other agents in this team session.',
    parameters: { type: 'object', properties: {} },
  },
];

const MAX_SUB_AGENT_ITERATIONS = 8;
const MAX_SESSIONS = 20;

export class AgentOrchestrator {
  private sessions = new Map<string, OrchestratorSession>();

  constructor(
    private llm:    LLMRouter,
    private skills: SkillsEngine,
    private config: GatewayConfig,
  ) {}

  getToolDef(): ToolDefinition {
    return {
      name: 'spawn_team',
      description: 'Spawn a team of parallel sub-agents to tackle complex tasks. Each sub-agent runs independently with its own role, task, and optional toolset. Agents can communicate with each other using agent_send and agent_read. Results are collected and returned as a summary.',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'The overall goal for the team' },
          agents: {
            type: 'array',
            description: 'List of sub-agents to spawn in parallel',
            items: {
              type: 'object',
              properties: {
                role:  { type: 'string', description: 'The role of this sub-agent (e.g. researcher, writer, analyst)' },
                task:  { type: 'string', description: 'The specific task for this sub-agent to complete' },
                tools: { type: 'array', description: 'Optional skill names this sub-agent may use', items: { type: 'string' } },
              },
              required: ['role', 'task'],
            },
          },
        },
        required: ['objective', 'agents'],
      },
    };
  }

  // ── Core session setup (shared between spawnTeam and spawnTeamAsync) ─────────
  private setupSession(objective: string, agentSpecs: SubAgentSpec[], nodeId: string): { session: OrchestratorSession; runs: SubAgentRun[]; sessionId: string } {
    const sessionId = crypto.randomUUID();
    messageBus.set(sessionId, []);

    const runs: SubAgentRun[] = agentSpecs.map(spec => ({
      id: crypto.randomUUID(), role: spec.role, task: spec.task,
      status: 'running' as const, started_at: Date.now(),
    }));

    const session: OrchestratorSession = {
      id: sessionId, node_id: nodeId, objective,
      agents: runs, created_at: Date.now(), status: 'running',
    };

    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = Array.from(this.sessions.entries()).sort(([, a], [, b]) => a.created_at - b.created_at)[0];
      if (oldest) { messageBus.delete(oldest[0]); this.sessions.delete(oldest[0]); }
    }

    this.sessions.set(sessionId, session);

    notifyDashboard4('session_start', {
      session_id: sessionId, objective, node_id: nodeId,
      agents: agentSpecs.map(s => ({ role: s.role, task: s.task, tools: s.tools ?? [] })),
    });

    return { session, runs, sessionId };
  }

  private buildStubCtx(): SkillContext {
    return {
      node_id: 'orchestrator', session_id: 'orchestrator', agent_id: 'orchestrator',
      anp:    { sendCommand: () => {} },
      memory: { search: async () => [] },
      channel:{ send: async () => {} },
      canvas: { append: () => {}, clear: () => {} },
    };
  }

  // ── Synchronous spawn (called by Gary via spawn_team tool) ────────────────
  async spawnTeam(args: Record<string, unknown>, nodeId: string, ctx: SkillContext): Promise<string> {
    const objective  = String(args['objective'] ?? '');
    const agentSpecs = (args['agents'] as SubAgentSpec[] | undefined) ?? [];
    const { session, runs, sessionId } = this.setupSession(objective, agentSpecs, nodeId);

    await Promise.all(agentSpecs.map((spec, i) => this.runSubAgent(sessionId, runs[i]!, spec, agentSpecs, ctx)));

    session.status = 'done';
    messageBus.delete(sessionId);
    notifyDashboard4('session_done', { session_id: sessionId });

    const summary = runs.map(r => {
      if (r.status === 'done')  return `[${r.role}] ${r.result ?? '(no result)'}`;
      if (r.status === 'error') return `[${r.role}] ERROR: ${r.error ?? 'unknown'}`;
      return `[${r.role}] (incomplete)`;
    }).join('\n\n');

    return `Team objective: ${objective}\n\nResults:\n${summary}`;
  }

  // ── Async spawn (called from dashboard4 REST endpoint) ───────────────────
  spawnTeamAsync(args: Record<string, unknown>, nodeId: string): string {
    const objective  = String(args['objective'] ?? '');
    const agentSpecs = (args['agents'] as SubAgentSpec[] | undefined) ?? [];
    const { session, runs, sessionId } = this.setupSession(objective, agentSpecs, nodeId);
    const ctx = this.buildStubCtx();

    Promise.all(agentSpecs.map((spec, i) => this.runSubAgent(sessionId, runs[i]!, spec, agentSpecs, ctx)))
      .then(() => {
        session.status = 'done';
        messageBus.delete(sessionId);
        notifyDashboard4('session_done', { session_id: sessionId });
      })
      .catch(err => console.error('[Orchestrator] async team error:', err));

    return sessionId;
  }

  // ── Sub-agent runner ──────────────────────────────────────────────────────
  private async runSubAgent(
    sessionId: string,
    run:       SubAgentRun,
    spec:      SubAgentSpec,
    allSpecs:  SubAgentSpec[],
    ctx:       SkillContext,
  ): Promise<void> {
    notifyDashboard4('agent_start', { session_id: sessionId, role: spec.role, task: spec.task });

    try {
      const skillTools = this.skills.getToolDefs(spec.tools ?? []);
      const rawTools   = [...skillTools, ...COMMS_TOOLS];
      // Deduplicate by name — Claude rejects requests with duplicate tool names
      const seen = new Set<string>();
      const allTools = rawTools.filter(t => {
        if (seen.has(t.name)) { console.warn(`[Orchestrator] Duplicate tool skipped for ${spec.role}: ${t.name}`); return false; }
        seen.add(t.name); return true;
      });
      const peers      = allSpecs.filter(s => s.role !== spec.role).map(s => s.role);

      const system = [
        `You are a ${spec.role}.`,
        `Task: ${spec.task}`,
        '',
        peers.length > 0
          ? `Your team: ${peers.join(', ')}. Use agent_send to share findings or ask for data. Use agent_read to check for messages.`
          : 'You are the sole agent in this session.',
        'Be concise. Return a clear final result when done.',
      ].join('\n');

      let messages: LLMMessage[] = [{ role: 'user', content: spec.task }];

      for (let iter = 0; iter < MAX_SUB_AGENT_ITERATIONS; iter++) {
        const response = await this.llm.complete('complex', {
          system, messages,
          tools:      allTools.length > 0 ? allTools : undefined,
          max_tokens: 2048,
        });

        if (!response.tool_calls || response.tool_calls.length === 0) {
          run.status  = 'done';
          run.result  = response.text;
          run.done_at = Date.now();
          notifyDashboard4('agent_done', { session_id: sessionId, role: spec.role, result: response.text });
          return;
        }

        messages = [...messages, { role: 'assistant' as const, content: response.text || '', tool_calls: response.tool_calls }];

        for (const call of response.tool_calls) {
          let result: unknown;
          try {
            if (call.name === 'agent_send') {
              const { to, message } = call.args as { to: string; message: string };
              busPost(sessionId, spec.role, to, message);
              result = { sent: true, to, from: spec.role };

            } else if (call.name === 'agent_read') {
              const msgs = busRead(sessionId, spec.role);
              result = msgs.length > 0
                ? { messages: msgs.map(m => ({ from: m.from, content: m.content })) }
                : { messages: [], note: 'No messages yet — peers may still be working.' };

            } else {
              // Emit tool_call event before executing so dashboard shows live activity
              const argsSummary = JSON.stringify(call.args).slice(0, 120);
              notifyDashboard4('tool_call', { session_id: sessionId, role: spec.role, tool: call.name, args_summary: argsSummary });
              result = await this.skills.execute(call.name, call.args as Record<string, unknown>, ctx);
            }
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          messages = [...messages, { role: 'tool' as const, content: JSON.stringify(result), tool_call_id: call.id }];
        }
      }

      // Max iterations reached
      const last = messages[messages.length - 1];
      run.status  = 'done';
      run.result  = last?.content ?? '(max iterations reached)';
      run.done_at = Date.now();
      notifyDashboard4('agent_done', { session_id: sessionId, role: spec.role, result: run.result });

    } catch (err) {
      run.status  = 'error';
      run.error   = err instanceof Error ? err.message : String(err);
      run.done_at = Date.now();
      notifyDashboard4('agent_error', { session_id: sessionId, role: spec.role, error: run.error });
    }
  }

  getSessions(): OrchestratorSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.created_at - a.created_at);
  }
}
