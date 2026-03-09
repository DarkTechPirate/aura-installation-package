import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { ANPEvent } from '../anp/types.js';
import crypto from 'crypto';

type SlackAppLike = {
  message(handler: (args: { message: unknown; say: unknown }) => Promise<void>): void;
  start(): Promise<unknown>;
  stop(): Promise<void>;
  client: {
    chat: {
      postMessage(args: { channel: string; text: string }): Promise<unknown>;
    };
  };
};

/**
 * Slack channel adapter using @slack/bolt.
 * node_id format: slack_<user_id>
 */
export class SlackAdapter implements ChannelAdapter {
  readonly channel_id = 'slack';
  private app: SlackAppLike | null = null;
  private handlers: Array<(event: ANPEvent) => void> = [];

  async init(config: ChannelConfig): Promise<void> {
    const botToken      = config['bot_token']      as string | undefined;
    const signingSecret = config['signing_secret'] as string | undefined;
    const appToken      = config['app_token']      as string | undefined;

    if (!botToken || !signingSecret || !appToken) {
      throw new Error('Slack requires bot_token, signing_secret, and app_token');
    }

    const { App } = await import('@slack/bolt');
    const app = new App({ token: botToken, signingSecret, appToken, socketMode: true });
    this.app = app as unknown as SlackAppLike;

    this.app.message(async ({ message }) => {
      const msg    = message as Record<string, unknown>;
      const userId = String(msg['user'] ?? '');
      const text   = String(msg['text'] ?? '');
      if (!userId || !text) return;

      const node_id = `slack_${userId}`;
      const event: ANPEvent = {
        type: 'event', event: 'utterance',
        node_id, session_id: crypto.randomUUID(),
        ts: Date.now(),
        payload: { text, routing_hint: 'complex' },
      };
      for (const h of this.handlers) h(event);
    });

    await this.app.start();
    console.log('[Slack] App started in Socket Mode');
  }

  onMessage(handler: (event: ANPEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.app) return;
    const userId = message.node_id.replace('slack_', '');
    if (message.text) await this.app.client.chat.postMessage({ channel: userId, text: message.text });
  }

  async isHealthy(): Promise<boolean> { return this.app !== null; }
  async destroy(): Promise<void> {
    await this.app?.stop();
    this.app = null;
  }
}
