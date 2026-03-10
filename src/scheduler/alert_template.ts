/**
 * AlertTemplate — general-purpose LLM alert delivery layer.
 *
 * Domain-agnostic: knows nothing about forex, trades, or any specific domain.
 * Each monitor builds its own Alert { text, context } — this template handles:
 *   - Current timestamp
 *   - Injecting whatever context the monitor provided
 *   - Full agent skill tools (LLM can call any skill before replying)
 *   - Delivery via send_to_agent_channels / send_message
 *
 * To add a new alert source in any domain:
 *   Build Alert { text, context? } → call template.fire(alert) → done.
 */

import type { LLMRouter }     from '../llm/router.js';
import type { SkillsEngine }  from '../skills/engine.js';
import type { SkillContext }  from '../skills/types.js';
import type { AgentConfig }   from '../agents/types.js';
import type { ChannelManager } from '../channels/manager.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { LLMMessage }    from '../llm/types.js';
import type { Alert }         from './pulse.js';
import { ProactiveTools }     from './proactive.js';
import { createLogger }       from '../logger.js';

const logger = createLogger('AlertTemplate');

const MAX_TOOL_ITERATIONS = 5;

const STUB_CTX: SkillContext = {
  node_id:    'alert',
  session_id: 'alert',
  agent_id:   'alert',
  anp:        { sendCommand: () => {} },
  memory:     { search: async () => [] },
  channel:    { send: async () => {} },
  canvas:     { append: () => {}, clear: () => {} },
};

export class AlertTemplate {
  constructor(
    private readonly llm:      LLMRouter,
    private readonly skills:   SkillsEngine,
    private readonly agent:    AgentConfig,
    private readonly channels: ChannelManager,
    private readonly agents:   AgentRegistry,
  ) {}

  /**
   * Deliver an alert through the LLM.
   * LLM receives: agent persona + current time + monitor-provided context + skill tools.
   *
   * @param alert - { text, context? } built by the monitor. Domain-agnostic.
   */
  async fire(alert: Alert): Promise<void> {
    try {
      await this.run(alert);
    } catch (err) {
      logger.error('AlertTemplate fire failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async run(alert: Alert): Promise<void> {
    const now = new Date().toLocaleString('en-SG', { timeZone: 'Asia/Singapore', hour12: false });

    // ── Build system prompt ─────────────────────────────────────────────────
    const systemParts = [
      this.agent.persona?.trim() ?? 'You are AURA, a personal AI assistant.',
      '',
      `Current time: ${now}`,
      '',
      '## Alert',
      'An automated monitor has detected a condition that needs the user\'s attention.',
      'Your job:',
      '  1. Read the alert and any context below.',
      '  2. Optionally call a skill tool if more information would help craft a better message.',
      '  3. Send one clear, concise message to the user via send_to_agent_channels.',
      '     - Lead with what happened.',
      '     - Include the key facts.',
      '     - Suggest one concrete action.',
      '     - Max 3 sentences.',
    ];

    if (alert.context) {
      systemParts.push('', '## Context', alert.context);
    }

    const system = systemParts.join('\n');

    // ── Tool set: agent skills + proactive delivery ─────────────────────────
    const pt         = new ProactiveTools(this.channels, this.agents);
    const skillTools = this.skills.getToolDefs(this.agent.skills ?? []);
    const allTools   = [...skillTools, ...pt.getToolDefs()];

    const messages: LLMMessage[] = [
      { role: 'user', content: alert.text },
    ];

    // ── LLM loop (max 5 iterations — fetch analysis then send) ──────────────
    let iterations = 0;
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const response = await this.llm.complete('simple', {
        system,
        messages,
        tools:      allTools,
        max_tokens: 300,
      });

      if (!response.tool_calls?.length) break;

      messages.push({
        role:       'assistant',
        content:    response.text ?? '',
        tool_calls: response.tool_calls,
      });

      for (const call of response.tool_calls) {
        let result: unknown;

        if (call.name === 'send_to_agent_channels') {
          result = await pt.send_to_agent_channels(call.args as { agent_id: string; text: string });
          logger.info('Alert sent via send_to_agent_channels', { agent_id: (call.args as any).agent_id });
        } else if (call.name === 'send_message') {
          result = await pt.send_message(call.args as { node_id: string; text: string });
          logger.info('Alert sent via send_message', { node_id: (call.args as any).node_id });
        } else {
          // Skill tool (e.g. forex_analysis) — execute and feed result back
          result = await this.skills.execute(call.name, call.args as Record<string, unknown>, STUB_CTX);
        }

        messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: call.id });
      }
    }
  }
}
