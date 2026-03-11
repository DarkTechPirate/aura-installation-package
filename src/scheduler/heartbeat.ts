import fs from 'fs';
import path from 'path';
import type { LLMRouter } from '../llm/router.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { MemoryManager } from '../memory/manager.js';
import type { SkillsEngine } from '../skills/engine.js';
import type { SkillContext } from '../skills/types.js';
import { ProactiveTools } from './proactive.js';
import type { ChannelManager } from '../channels/manager.js';
import { AURA_DIR } from '../config/loader.js';
import type { LLMMessage, ToolCall } from '../llm/types.js';

const HEARTBEAT_MD = path.join(AURA_DIR, 'HEARTBEAT.md');
const MAX_TOOL_ITERATIONS = 10;

export interface HeartbeatLogEntry {
  ts:      number;
  result:  'HEARTBEAT_OK' | 'acted' | 'error';
  detail?: string;
}

/**
 * Heartbeat runner: reads HEARTBEAT.md, calls LLM with proactive + skill tools,
 * acts on tool calls or exits silently if LLM returns "HEARTBEAT_OK".
 * Logs every run.
 */
export class HeartbeatRunner {
  private log: HeartbeatLogEntry[] = [];
  private proactive: ProactiveTools;

  constructor(
    private readonly llm: LLMRouter,
    private readonly agents: AgentRegistry,
    private readonly memory: MemoryManager,
    private readonly skills: SkillsEngine,
    private readonly channels: ChannelManager,
  ) {
    this.proactive = new ProactiveTools(channels, agents);
  }

  async run(): Promise<HeartbeatLogEntry> {
    console.log('[Heartbeat] Running...');
    this.proactive.resetCounter();

    let entry: HeartbeatLogEntry;
    try {
      const result = await this.runHeartbeatLoop();
      entry = { ts: Date.now(), result, detail: undefined };
      console.log(`[Heartbeat] ${result}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      entry = { ts: Date.now(), result: 'error', detail };
      console.error('[Heartbeat] Error:', detail);
    }

    this.log.unshift(entry);
    if (this.log.length > 50) this.log.length = 50;
    return entry;
  }

  private async runHeartbeatLoop(): Promise<'HEARTBEAT_OK' | 'acted'> {
    const instructions = this.readHeartbeatMd();
    const now          = new Date().toISOString();

    // Use the personal agent for heartbeat context
    const agent = this.agents.get('personal') ?? this.agents.getAll()[0];
    if (!agent) return 'HEARTBEAT_OK';

    const persona    = agent.persona?.trim() ?? 'You are AURA, a personal AI assistant.';
    const skillTools = this.skills.getToolDefs(agent.skills ?? []);
    const proactiveTools = this.proactive.getToolDefs();
    const allTools   = [...skillTools, ...proactiveTools];

    const system = [
      persona,
      `Current time: ${now}`,
      '',
      'You are running as an autonomous heartbeat process. Read the instructions below and decide what (if anything) to do.',
      'If none of the conditions in HEARTBEAT.md apply right now, respond with EXACTLY: HEARTBEAT_OK',
      'Never send unnecessary messages. Quality over quantity.',
      '',
      '## HEARTBEAT INSTRUCTIONS',
      instructions,
    ].join('\n');

    const messages: LLMMessage[] = [
      { role: 'user', content: 'Run heartbeat check now.' },
    ];

    let iterations = 0;
    let acted      = false;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const response = await this.llm.complete(agent.llm_tier, { system, messages, tools: allTools }, 'background');
      const text = response.text.trim();

      // LLM responded with final text
      if (!response.tool_calls || response.tool_calls.length === 0) {
        if (text === 'HEARTBEAT_OK') return acted ? 'acted' : 'HEARTBEAT_OK';
        // LLM said something other than HEARTBEAT_OK — that's unexpected but log it
        console.log('[Heartbeat] LLM response:', text.slice(0, 200));
        return 'acted';
      }

      // Execute tool calls — must include tool_calls in assistant message so
      // Claude can match tool_result blocks to their tool_use blocks.
      messages.push({ role: 'assistant', content: text || '', tool_calls: response.tool_calls });
      acted = true;

      for (const call of response.tool_calls) {
        if (!call.name) continue; // skip malformed empty-name tool calls
        const result = await this.executeHeartbeatTool(call, agent.memory_ns);
        messages.push({ role: 'tool', content: String(result), tool_call_id: call.id });
      }
    }

    console.warn('[Heartbeat] Max iterations reached');
    return 'acted';
  }

  private async executeHeartbeatTool(call: ToolCall, memory_ns: string): Promise<unknown> {
    console.log(`[Heartbeat] tool_call: ${call.name}`);
    const args = call.args as Record<string, unknown>;

    // Proactive outreach tools
    if (call.name === 'send_message') {
      return this.proactive.send_message(args as { node_id: string; text: string });
    }
    if (call.name === 'send_to_agent_channels') {
      return this.proactive.send_to_agent_channels(args as { agent_id: string; text: string });
    }

    // Skill tools — build a minimal SkillContext
    const ctx: SkillContext = {
      node_id:    'heartbeat',
      session_id: 'heartbeat',
      agent_id:   memory_ns,
      anp:        { sendCommand: () => {} },
      memory:     { search: (q) => this.memory.search(memory_ns, q) },
      channel:    { send: (nid, txt) => this.channels.send(nid, txt) },
      canvas:     { append: () => {}, clear: () => {} },
    };

    return this.skills.execute(call.name, args, ctx);
  }

  private readHeartbeatMd(): string {
    if (fs.existsSync(HEARTBEAT_MD)) {
      return fs.readFileSync(HEARTBEAT_MD, 'utf8');
    }
    return '## Silent rule\nIf nothing requires attention: respond ONLY "HEARTBEAT_OK".';
  }

  getLog(): HeartbeatLogEntry[] {
    return [...this.log];
  }
}
