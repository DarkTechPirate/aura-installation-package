import http from 'http';
import crypto from 'crypto';
import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { ANPEvent } from '../anp/types.js';

/**
 * Google Chat channel adapter using googleapis REST.
 * node_id format: gchat_<space_id>
 * Credentials: service account JSON at GOOGLE_CHAT_CREDENTIALS_PATH.
 * Receives messages via HTTP webhook on port 3003 (configurable).
 */
export class GoogleChatAdapter implements ChannelAdapter {
  readonly channel_id = 'gchat';
  private authClient: unknown = null;
  private chatClient: unknown = null;
  private server: http.Server | null = null;
  private handlers: Array<(event: ANPEvent) => void> = [];
  private webhookPort: number = 3003;

  async init(config: ChannelConfig): Promise<void> {
    const credPath = config['credentials'] as string | undefined
      ?? process.env['GOOGLE_CHAT_CREDENTIALS_PATH'];

    if (!credPath) throw new Error('Google Chat credentials path required');
    this.webhookPort = (config['webhook_port'] as number | undefined) ?? 3003;

    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      keyFile: credPath,
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });
    this.authClient = await auth.getClient();
    this.chatClient = google.chat({ version: 'v1', auth: this.authClient as never });

    // Start inbound webhook HTTP server
    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const evt = JSON.parse(body) as Record<string, unknown>;
          this.handleInbound(evt);
        } catch { /* ignore malformed */ }
        res.writeHead(200).end(JSON.stringify({ text: '' }));
      });
    });

    await new Promise<void>((resolve) =>
      this.server!.listen(this.webhookPort, '127.0.0.1', resolve)
    );

    console.log(`[GoogleChat] Webhook listening on 127.0.0.1:${this.webhookPort}`);
  }

  private handleInbound(evt: Record<string, unknown>): void {
    const type = String(evt['type'] ?? '');
    if (type !== 'MESSAGE') return;

    const message = evt['message'] as Record<string, unknown> | undefined;
    const space   = evt['space']   as Record<string, unknown> | undefined;
    const spaceId = String(space?.['name'] ?? '').split('/').pop() ?? '';
    const text    = String(message?.['text'] ?? '').trim();

    if (!spaceId || !text) return;

    const node_id = `gchat_${spaceId}`;
    const event: ANPEvent = {
      type: 'event', event: 'utterance',
      node_id, session_id: crypto.randomUUID(),
      ts: Date.now(),
      payload: { text, routing_hint: 'complex' },
    };
    for (const h of this.handlers) h(event);
  }

  onMessage(handler: (event: ANPEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.chatClient) return;
    const spaceId = message.node_id.replace('gchat_', '');
    const client = this.chatClient as {
      spaces: { messages: { create: (req: unknown) => Promise<unknown> } }
    };
    await client.spaces.messages.create({
      parent: `spaces/${spaceId}`,
      requestBody: { text: message.text },
    });
  }

  async isHealthy(): Promise<boolean> {
    return this.chatClient !== null && this.server !== null;
  }

  async destroy(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
    this.chatClient = null;
    this.authClient = null;
  }
}
