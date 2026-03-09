import type { ChannelAdapter, ChannelConfig, MediaAttachment } from './interface.js';
import type { ANPEvent } from '../anp/types.js';
import type { GatewayConfig } from '../config/loader.js';

/**
 * Manages all channel adapters: starts enabled ones, routes outbound messages.
 */
export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private handlers: Array<(event: ANPEvent) => void> = [];

  async init(config: GatewayConfig, adapterMap: Record<string, ChannelAdapter>): Promise<void> {
    for (const [name, adapter] of Object.entries(adapterMap)) {
      const cfg = config.channels[name] as ChannelConfig | undefined;
      if (!cfg?.enabled) continue;

      try {
        await adapter.init(cfg);
        adapter.onMessage((event) => {
          for (const h of this.handlers) h(event);
        });
        this.adapters.set(name, adapter);
        console.log(`[Channels] Started: ${name}`);
      } catch (err) {
        console.error(`[Channels] Failed to start ${name}:`, err);
      }
    }
  }

  onMessage(handler: (event: ANPEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(node_id: string, text?: string, attachments?: MediaAttachment[]): Promise<void> {
    // Find the adapter that owns this node_id prefix
    for (const adapter of this.adapters.values()) {
      if (node_id.startsWith(adapter.channel_id + '_') || node_id === adapter.channel_id) {
        await adapter.send({ node_id, text, attachments });
        return;
      }
    }
    console.warn(`[Channels] No adapter found for node_id: ${node_id}`);
  }

  /** Send a typing/composing indicator if the adapter supports it. */
  async sendTyping(node_id: string): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (node_id.startsWith(adapter.channel_id + '_') || node_id === adapter.channel_id) {
        await adapter.sendTyping?.(node_id);
        return;
      }
    }
  }

  async destroy(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try { await adapter.destroy(); } catch {}
    }
    this.adapters.clear();
  }
}
