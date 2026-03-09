import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { ANPEvent } from '../anp/types.js';
import crypto from 'crypto';

/**
 * Discord channel adapter using discord.js.
 * node_id format: discord_<user_id>
 */
export class DiscordAdapter implements ChannelAdapter {
  readonly channel_id = 'discord';
  private client: unknown = null;
  private handlers: Array<(event: ANPEvent) => void> = [];

  async init(config: ChannelConfig): Promise<void> {
    const token = config['token'] as string | undefined;
    if (!token) throw new Error('Discord token required');

    const { Client, GatewayIntentBits } = await import('discord.js');
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    });
    this.client = client;

    (client as unknown as { on(e: string, h: (m: unknown) => void): void }).on('messageCreate', (rawMsg: unknown) => {
      const message = rawMsg as Record<string, unknown>;
      if ((message['author'] as Record<string, unknown>)?.['bot']) return;
      const author = message['author'] as Record<string, unknown>;
      const userId = String(author['id'] ?? '');
      const content = String(message['content'] ?? '');
      if (!userId || !content) return;

      const node_id = `discord_${userId}`;
      const event: ANPEvent = {
        type: 'event', event: 'utterance',
        node_id, session_id: crypto.randomUUID(),
        ts: Date.now(),
        payload: { text: content, routing_hint: 'complex' },
      };
      for (const h of this.handlers) h(event);
    });

    await client.login(token);
    console.log('[Discord] Bot logged in');
  }

  onMessage(handler: (event: ANPEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.client) return;
    const userId = message.node_id.replace('discord_', '');
    const client = this.client as { users: { fetch: (id: string) => Promise<{ send: (text: string) => Promise<void> }> } };
    const user = await client.users.fetch(userId);
    if (message.text) await user.send(message.text);
  }

  async isHealthy(): Promise<boolean> { return this.client !== null; }
  async destroy(): Promise<void> {
    await (this.client as Record<string, () => Promise<void>>)?.destroy?.();
    this.client = null;
  }
}
