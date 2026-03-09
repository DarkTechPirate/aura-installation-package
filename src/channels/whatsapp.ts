import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { ANPEvent } from '../anp/types.js';
import crypto from 'crypto';

/**
 * WhatsApp channel adapter using whatsapp-web.js.
 * node_id format: whatsapp_<phone_number>
 * First run: QR scan required. Session persists at ~/.aura/tokens/whatsapp/
 */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel_id = 'whatsapp';
  private client: unknown = null;
  private handlers: Array<(event: ANPEvent) => void> = [];

  async init(_config: ChannelConfig): Promise<void> {
    const { Client, LocalAuth } = await import('whatsapp-web.js');
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: `${process.env['HOME']}/.aura/tokens/whatsapp` }),
      puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    });
    this.client = client;

    client.on('qr', (qr: string) => {
      console.log('[WhatsApp] QR Code (scan to authenticate):');
      console.log(qr);
    });

    client.on('ready', () => console.log('[WhatsApp] Client ready'));

    client.on('message', (msg: Record<string, unknown>) => {
      if (msg['fromMe']) return;
      const from = String(msg['from'] ?? '').replace('@c.us', '');
      const body = String(msg['body'] ?? '');
      if (!from || !body) return;

      const node_id = `whatsapp_${from}`;
      const event: ANPEvent = {
        type: 'event', event: 'utterance',
        node_id, session_id: crypto.randomUUID(),
        ts: Date.now(),
        payload: { text: body, routing_hint: 'simple' },
      };
      for (const h of this.handlers) h(event);
    });

    await client.initialize();
  }

  onMessage(handler: (event: ANPEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    if (!this.client) return;
    const phone = message.node_id.replace('whatsapp_', '');
    const client = this.client as { sendMessage: (to: string, text: string) => Promise<void> };
    if (message.text) await client.sendMessage(`${phone}@c.us`, message.text);
  }

  async isHealthy(): Promise<boolean> { return this.client !== null; }
  async destroy(): Promise<void> {
    await (this.client as Record<string, () => Promise<void>>)?.destroy?.();
    this.client = null;
  }
}
