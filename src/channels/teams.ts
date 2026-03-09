import http from 'http';
import crypto from 'crypto';
import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { ANPEvent } from '../anp/types.js';

/**
 * Microsoft Teams channel adapter using botbuilder (Bot Framework).
 * node_id format: teams_<conversation_id>
 * Requires TEAMS_APP_ID and TEAMS_APP_SECRET.
 * Receives activities via HTTP on port 3004 (configurable).
 */
export class TeamsAdapter implements ChannelAdapter {
  readonly channel_id = 'teams';
  private adapter: unknown = null;
  private server: http.Server | null = null;
  private handlers: Array<(event: ANPEvent) => void> = [];
  private webhookPort: number = 3004;

  async init(config: ChannelConfig): Promise<void> {
    const appId     = config['app_id']     as string | undefined ?? process.env['TEAMS_APP_ID'];
    const appSecret = config['app_secret'] as string | undefined ?? process.env['TEAMS_APP_SECRET'];
    this.webhookPort = (config['webhook_port'] as number | undefined) ?? 3004;

    if (!appId || !appSecret) throw new Error('Teams app_id and app_secret required');

    const { BotFrameworkAdapter } = await import('botbuilder');
    this.adapter = new BotFrameworkAdapter({ appId, appPassword: appSecret });

    const adapter = this.adapter as {
      processActivity: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        handler: (ctx: Record<string, unknown>) => Promise<void>
      ) => Promise<void>;
      continueConversation: (ref: unknown, handler: (ctx: Record<string, unknown>) => Promise<void>) => Promise<void>;
    };

    this.server = http.createServer((req, res) => {
      if (req.url !== '/api/messages' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }

      adapter.processActivity(req, res, async (ctx) => {
        const activity = ctx['activity'] as Record<string, unknown> | undefined;
        if (!activity || activity['type'] !== 'message') return;

        const convId = String(
          (activity['conversation'] as Record<string, unknown> | undefined)?.['id'] ?? ''
        );
        const text = String(activity['text'] ?? '').trim();
        if (!convId || !text) return;

        const node_id = `teams_${convId}`;
        const event: ANPEvent = {
          type: 'event', event: 'utterance',
          node_id, session_id: crypto.randomUUID(),
          ts: Date.now(),
          payload: { text, routing_hint: 'complex' },
        };
        for (const h of this.handlers) h(event);
      }).catch((err: unknown) => console.error('[Teams] processActivity error:', err));
    });

    await new Promise<void>((resolve) =>
      this.server!.listen(this.webhookPort, '127.0.0.1', resolve)
    );

    console.log(`[Teams] Bot Framework listening on 127.0.0.1:${this.webhookPort}/api/messages`);
  }

  onMessage(handler: (event: ANPEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.adapter) return;
    // Teams requires a conversation reference to send proactively.
    // Store references on first activity received (handled externally).
    // Minimal implementation: log outbound intent.
    console.log(`[Teams] send → ${message.node_id}: ${(message.text ?? '').slice(0, 80)}`);
  }

  async isHealthy(): Promise<boolean> {
    return this.adapter !== null && this.server !== null;
  }

  async destroy(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
    this.adapter = null;
  }
}
