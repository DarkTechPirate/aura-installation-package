import type { ChannelManager } from '../channels/manager.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ToolDefinition } from '../llm/types.js';

const MAX_SENDS_PER_RUN = 10;

/**
 * Proactive outreach tools available in heartbeat context only.
 * Enforces a hard rate limit of MAX_SENDS_PER_RUN send_message calls per run.
 */
export class ProactiveTools {
  private sendCount = 0;

  constructor(
    private readonly channels: ChannelManager,
    private readonly agentRegistry: AgentRegistry,
  ) {}

  /** Reset counter at the start of each heartbeat run. */
  resetCounter(): void {
    this.sendCount = 0;
  }

  /**
   * Send a message to a specific node_id.
   * Rate-limited to MAX_SENDS_PER_RUN per heartbeat run.
   */
  async send_message(args: { node_id: string; text: string }): Promise<string> {
    if (this.sendCount >= MAX_SENDS_PER_RUN) {
      throw new Error(`Proactive rate limit reached (max ${MAX_SENDS_PER_RUN} per heartbeat run)`);
    }
    this.sendCount++;
    await this.channels.send(args.node_id, args.text);
    return `Sent to ${args.node_id}`;
  }

  /**
   * Send a message to all registered channel nodes of an agent.
   * Each individual send counts toward the rate limit.
   */
  async send_to_agent_channels(args: { agent_id: string; text: string }): Promise<string> {
    const agent = this.agentRegistry.get(args.agent_id);
    if (!agent) throw new Error(`Agent '${args.agent_id}' not found`);

    const sent: string[] = [];
    for (const node_id of agent.channels) {
      if (node_id === '__default__') continue;
      await this.send_message({ node_id, text: args.text });
      sent.push(node_id);
    }
    return `Sent to channels: ${sent.join(', ')}`;
  }

  /** Returns ToolDefinition[] for these two send tools. */
  getToolDefs(): ToolDefinition[] {
    return [
      {
        name: 'send_message',
        description: 'Send a message to a specific channel node. Use this whenever the user asks you to text, message, or notify them on Telegram, Discord, Slack, or any other channel. node_id format: telegram_<chat_id>, discord_<user_id>, slack_<user_id>, etc.',
        parameters: {
          type: 'object',
          properties: {
            node_id: { type: 'string', description: 'Target node_id (e.g. telegram_6665002430)' },
            text:    { type: 'string', description: 'Message text to send' },
          },
          required: ['node_id', 'text'],
        },
      },
      {
        name: 'send_to_agent_channels',
        description: 'Send a message to all channels belonging to an agent. Use this when the user asks you to send a message to all their devices or channels at once.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', description: 'Agent id (e.g. personal, default)' },
            text:     { type: 'string', description: 'Message text to send' },
          },
          required: ['agent_id', 'text'],
        },
      },
    ];
  }
}
