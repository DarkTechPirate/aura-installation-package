/**
 * AgentOrchestrator — spawn_team multi-agent engine.
 *
 * OpenProse-inspired features:
 *   block:        — reusable agent templates (define_block tool / blocks registry)
 *   resume:       — resume a prior agent from its saved message history (resume_agent tool)
 *   recursive     — sub-agents can call spawn_team (depth-guarded, MAX_RECURSION_DEPTH)
 *   pause_for_input — agent pauses mid-task, sends message to user, resumes on reply
 */

import crypto    from 'crypto';
import os        from 'os';
import path      from 'path';
import Database  from 'better-sqlite3';
import type { LLMRouter }        from '../llm/router.js';
import type { SkillsEngine }     from '../skills/engine.js';
import type { GatewayConfig }    from '../config/loader.js';
import type { LLMMessage, ToolDefinition } from '../llm/types.js';
import type { SkillContext }     from '../skills/types.js';
import { createLogger }          from '../logger.js';
import { BlocksRegistry }        from './blocks.js';
import { notifyDashboard4, messageBus, busPost, busRead, COMMS_TOOLS } from './bus.js';

const logger = createLogger('Orchestrator');
const SESSION_DB_PATH      = path.join(os.homedir(), '.aura', 'memory', 'aura.db');
const MAX_SUB_AGENT_ITERATIONS = 8;
const MAX_SESSIONS             = 20;
const MAX_RECURSION_DEPTH      = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubAgentSpec {
  role:   string;
  task:   string;
  tools?: string[];
  block?: string;   // reference a named block template
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

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class AgentOrchestrator {
  private sessions = new Map<string, OrchestratorSession>();
  /** sessionId → resolve fn for pause_for_input */
  private paused   = new Map<string, { resolve: (answer: string) => void }>();
  private db:       Database.Database;
  readonly blocks:  BlocksRegistry;

  constructor(
    private llm:    LLMRouter,
    private skills: SkillsEngine,
    private config: GatewayConfig,
  ) {
    this.blocks = new BlocksRegistry();
    this.db = new Database(SESSION_DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_sessions (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, objective TEXT NOT NULL,
        agents TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_message_history (
        session_id TEXT NOT NULL, agent_role TEXT NOT NULL,
        messages TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, agent_role)
      );
    `);
  }

  // ── History ───────────────────────────────────────────────────────────────

  private saveHistory(sessionId: string, role: string, messages: LLMMessage[]): void {
    try {
      this.db.prepare(`
        INSERT INTO agent_message_history (session_id, agent_role, messages, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, agent_role)
        DO UPDATE SET messages=excluded.messages, updated_at=excluded.updated_at
      `).run(sessionId, role, JSON.stringify(messages), Date.now());
    } catch (err) { logger.warn('Failed to save agent history', { error: String(err) }); }
  }

  private loadHistory(sessionId: string, role: string): LLMMessage[] | null {
    try {
      const row = this.db.prepare(
        'SELECT messages FROM agent_message_history WHERE session_id=? AND agent_role=?'
      ).get(sessionId, role) as { messages: string } | undefined;
      return row ? (JSON.parse(row.messages) as LLMMessage[]) : null;
    } catch { return null; }
  }

  // ── Pause gate (called from server.ts when user sends a message) ──────────

  hasPendingPause(sessionId: string): boolean {
    return this.paused.has(sessionId);
  }

  resolvePause(sessionId: string, answer: string): boolean {
    const p = this.paused.get(sessionId);
    if (!p) return false;
    this.paused.delete(sessionId);
    p.resolve(answer);
    return true;
  }

  // ── Session persistence ───────────────────────────────────────────────────

  private persistSession(session: OrchestratorSession): void {
    try {
      this.db.prepare(`
        INSERT INTO orchestrator_sessions (id, node_id, objective, agents, status, created_at, updated_at)
        VALUES (@id, @node_id, @objective, @agents, @status, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET agents=excluded.agents, status=excluded.status, updated_at=excluded.updated_at
      `).run({ ...session, agents: JSON.stringify(session.agents), updated_at: Date.now() });
    } catch (err) { logger.warn('Failed to persist session', { error: String(err) }); }
  }

  // ── Session setup ─────────────────────────────────────────────────────────

  private setupSession(
    objective:  string,
    agentSpecs: SubAgentSpec[],
    nodeId:     string,
  ): { session: OrchestratorSession; runs: SubAgentRun[]; sessionId: string } {
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
      const oldest = Array.from(this.sessions.entries())
        .sort(([, a], [, b]) => a.created_at - b.created_at)[0];
      if (oldest) { messageBus.delete(oldest[0]); this.sessions.delete(oldest[0]); }
    }

    this.sessions.set(sessionId, session);
    this.persistSession(session);
    notifyDashboard4('session_start', {
      session_id: sessionId, objective, node_id: nodeId,
      agents: agentSpecs.map(s => ({ role: s.role, task: s.task, tools: s.tools ?? [] })),
    });

    return { session, runs, sessionId };
  }

  // ── Block resolution ──────────────────────────────────────────────────────

  private resolveSpecs(rawSpecs: SubAgentSpec[]): SubAgentSpec[] {
    return rawSpecs.map(spec => {
      if (!spec.block) return spec;
      const block = this.blocks.get(spec.block);
      if (!block) { logger.warn(`Block '${spec.block}' not found — using spec as-is`); return spec; }
      // Spec fields override block defaults (task/tools can be specialised per call)
      return { ...block, ...spec, block: undefined };
    });
  }

  // ── Tool definitions ──────────────────────────────────────────────────────

  getToolDefs(): ToolDefinition[] {
    return [
      {
        name: 'spawn_team',
        description: 'Spawn a team of parallel sub-agents. Each agent runs independently with its own role and task. Agents can communicate via agent_send/agent_read. Reference a pre-defined block with the block field.',
        parameters: {
          type: 'object',
          properties: {
            objective: { type: 'string', description: 'Overall goal for the team' },
            agents: {
              type: 'array',
              description: 'Sub-agents to spawn in parallel',
              items: {
                type: 'object',
                properties: {
                  role:  { type: 'string', description: 'Agent role (e.g. researcher, analyst)' },
                  task:  { type: 'string', description: 'Specific task for this agent' },
                  tools: { type: 'array', description: 'Skill names this agent may use', items: { type: 'string' } },
                  block: { type: 'string', description: 'Name of a pre-defined block template' },
                },
                required: ['role', 'task'],
              },
            },
          },
          required: ['objective', 'agents'],
        },
      },
      {
        name: 'resume_agent',
        description: 'Resume a previously run sub-agent from its saved message history, optionally with a new follow-up task.',
        parameters: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'session_id of the previous run to resume from' },
            role:       { type: 'string', description: 'Role (agent name) to resume' },
            new_task:   { type: 'string', description: 'Optional follow-up task to inject as a new user message' },
          },
          required: ['session_id', 'role'],
        },
      },
      {
        name: 'define_block',
        description: 'Define a reusable agent block template. Future spawn_team calls can reference it by name using the block field.',
        parameters: {
          type: 'object',
          properties: {
            name:  { type: 'string', description: 'Unique block name' },
            role:  { type: 'string', description: 'Default role for agents using this block' },
            task:  { type: 'string', description: 'Default task description' },
            tools: { type: 'array', description: 'Default tool list', items: { type: 'string' } },
          },
          required: ['name', 'role', 'task'],
        },
      },
    ];
  }

  /** Backward-compatible single accessor (returns spawn_team def). */
  getToolDef(): ToolDefinition { return this.getToolDefs()[0]!; }

  // ── Public API ────────────────────────────────────────────────────────────

  async spawnTeam(args: Record<string, unknown>, nodeId: string, ctx: SkillContext): Promise<string> {
    const objective  = String(args['objective'] ?? '');
    const agentSpecs = this.resolveSpecs((args['agents'] as SubAgentSpec[] | undefined) ?? []);
    return this._spawnInternal(objective, agentSpecs, nodeId, ctx, 0);
  }

  async resumeAgent(args: Record<string, unknown>, nodeId: string, ctx: SkillContext): Promise<string> {
    const sessionId = String(args['session_id'] ?? '');
    const role      = String(args['role'] ?? '');
    const newTask   = args['new_task'] ? String(args['new_task']) : undefined;

    const history = this.loadHistory(sessionId, role);
    if (!history) return `No saved history found for session '${sessionId}' role '${role}'.`;

    const run:  SubAgentRun  = { id: crypto.randomUUID(), role, task: newTask ?? '(resumed)', status: 'running', started_at: Date.now() };
    const spec: SubAgentSpec = { role, task: newTask ?? '(resumed)' };
    const resumeSessionId    = crypto.randomUUID();
    messageBus.set(resumeSessionId, []);
    notifyDashboard4('agent_resume', { session_id: resumeSessionId, role, from_session: sessionId });

    await this.runSubAgent(resumeSessionId, run, spec, [], ctx, 0, history, newTask);
    messageBus.delete(resumeSessionId);
    return `[${role} resumed]\n${run.result ?? run.error ?? '(no output)'}`;
  }

  spawnTeamAsync(args: Record<string, unknown>, nodeId: string): string {
    const objective  = String(args['objective'] ?? '');
    const agentSpecs = this.resolveSpecs((args['agents'] as SubAgentSpec[] | undefined) ?? []);
    const ctx = this.buildStubCtx();
    const { session, runs, sessionId } = this.setupSession(objective, agentSpecs, nodeId);
    Promise.all(agentSpecs.map((spec, i) => this.runSubAgent(sessionId, runs[i]!, spec, agentSpecs, ctx, 0)))
      .then(() => {
        session.status = 'done';
        this.persistSession(session);
        messageBus.delete(sessionId);
        notifyDashboard4('session_done', { session_id: sessionId });
      })
      .catch(err => console.error('[Orchestrator] async team error:', err));
    return sessionId;
  }

  getSessions(): OrchestratorSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.created_at - a.created_at);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async _spawnInternal(
    objective:  string,
    agentSpecs: SubAgentSpec[],
    nodeId:     string,
    ctx:        SkillContext,
    depth:      number,
  ): Promise<string> {
    const { session, runs, sessionId } = this.setupSession(objective, agentSpecs, nodeId);
    await Promise.all(agentSpecs.map((spec, i) =>
      this.runSubAgent(sessionId, runs[i]!, spec, agentSpecs, ctx, depth)
    ));
    session.status = 'done';
    this.persistSession(session);
    messageBus.delete(sessionId);
    notifyDashboard4('session_done', { session_id: sessionId });

    const summary = runs.map(r =>
      r.status === 'done'  ? `[${r.role}] ${r.result ?? '(no result)'}` :
      r.status === 'error' ? `[${r.role}] ERROR: ${r.error ?? 'unknown'}` :
      `[${r.role}] (incomplete)`
    ).join('\n\n');

    return `Team objective: ${objective}\n\nResults:\n${summary}`;
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

  private async runSubAgent(
    sessionId:    string,
    run:          SubAgentRun,
    spec:         SubAgentSpec,
    allSpecs:     SubAgentSpec[],
    ctx:          SkillContext,
    depth:        number,
    priorHistory: LLMMessage[] | null = null,
    newTask?:     string,
  ): Promise<void> {
    notifyDashboard4('agent_start', { session_id: sessionId, role: spec.role, task: spec.task, depth });
    try {
      const skillTools = this.skills.getToolDefs(spec.tools ?? []);
      // At depth < MAX_RECURSION_DEPTH: inject spawn_team, resume_agent, define_block
      const extraTools = depth < MAX_RECURSION_DEPTH ? this.getToolDefs() : [];
      const rawTools   = [...skillTools, ...COMMS_TOOLS, ...extraTools];
      const seen       = new Set<string>();
      const allTools   = rawTools.filter(t => {
        if (seen.has(t.name)) return false;
        seen.add(t.name); return true;
      });

      const peers  = allSpecs.filter(s => s.role !== spec.role).map(s => s.role);
      const system = [
        `You are a ${spec.role}.`,
        `Task: ${spec.task}`,
        '',
        peers.length > 0
          ? `Your team: ${peers.join(', ')}. Use agent_send/agent_read to coordinate.`
          : 'You are the sole agent in this session.',
        depth > 0 ? `You are a sub-agent at recursion depth ${depth}/${MAX_RECURSION_DEPTH}.` : '',
        'Be concise. Return a clear final result when done.',
      ].filter(Boolean).join('\n');

      let messages: LLMMessage[] = priorHistory
        ? (newTask ? [...priorHistory, { role: 'user', content: newTask }] : priorHistory)
        : [{ role: 'user', content: spec.task }];

      for (let iter = 0; iter < MAX_SUB_AGENT_ITERATIONS; iter++) {
        const response = await this.llm.complete('complex', {
          system, messages,
          tools:      allTools.length > 0 ? allTools : undefined,
          max_tokens: 2048,
        }, 'agent');

        if (!response.tool_calls || response.tool_calls.length === 0) {
          run.status = 'done'; run.result = response.text; run.done_at = Date.now();
          this.saveHistory(sessionId, run.role, messages);
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

            } else if (call.name === 'pause_for_input') {
              const { message } = call.args as { message: string };
              await ctx.channel.send(message);
              this.saveHistory(sessionId, run.role, messages);
              notifyDashboard4('agent_paused', { session_id: sessionId, role: spec.role, message });
              // Block until server.ts routes the user's reply to resolvePause()
              const answer = await new Promise<string>(resolve => {
                this.paused.set(sessionId, { resolve });
              });
              notifyDashboard4('agent_resumed', { session_id: sessionId, role: spec.role });
              result = { answer, resumed: true };

            } else if (call.name === 'spawn_team' && depth < MAX_RECURSION_DEPTH) {
              const subSpecs = this.resolveSpecs((call.args['agents'] as SubAgentSpec[] | undefined) ?? []);
              result = await this._spawnInternal(
                String(call.args['objective'] ?? ''), subSpecs, run.role, ctx, depth + 1
              );

            } else if (call.name === 'resume_agent') {
              result = await this.resumeAgent(call.args as Record<string, unknown>, run.role, ctx);

            } else if (call.name === 'define_block') {
              const { name, role, task, tools } = call.args as { name: string; role: string; task: string; tools?: string[] };
              this.blocks.define(name, { role, task, tools });
              result = { defined: true, name };

            } else {
              notifyDashboard4('tool_call', {
                session_id: sessionId, role: spec.role,
                tool: call.name, args_summary: JSON.stringify(call.args).slice(0, 120),
              });
              result = await this.skills.execute(call.name, call.args as Record<string, unknown>, ctx);
            }
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          messages = [...messages, { role: 'tool' as const, content: JSON.stringify(result), tool_call_id: call.id }];
        }

        this.saveHistory(sessionId, run.role, messages);
      }

      // Max iterations reached — return last message content
      const last = messages[messages.length - 1];
      run.status = 'done';
      run.result = typeof last?.content === 'string' ? last.content : '(max iterations reached)';
      run.done_at = Date.now();
      notifyDashboard4('agent_done', { session_id: sessionId, role: spec.role, result: run.result });

    } catch (err) {
      run.status = 'error';
      run.error   = err instanceof Error ? err.message : String(err);
      run.done_at = Date.now();
      notifyDashboard4('agent_error', { session_id: sessionId, role: spec.role, error: run.error });
    }
  }
}
