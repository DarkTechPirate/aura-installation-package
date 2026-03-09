import type { ChannelAdapter, ChannelConfig, MediaAttachment } from './interface.js';
import type { ANPEvent } from '../anp/types.js';
import type { GatewayConfig } from '../config/loader.js';

/** Factory signature: resolves to a constructor that produces a ChannelAdapter. */
type AdapterFactory = () => Promise<new () => ChannelAdapter>;

/**
 * Maps channel names to their module paths for dynamic (lazy) loading.
 * Only channels that are enabled in config.yaml are ever imported.
 * Add new channel adapters here — no changes to server.ts needed.
 */
const CHANNEL_REGISTRY: Record<string, AdapterFactory> = {
  telegram:    async () => (await import('./telegram.js')).TelegramAdapter,
  whatsapp:    async () => (await import('./whatsapp.js')).WhatsAppAdapter,
  signal:      async () => (await import('./signal.js')).SignalAdapter,
  slack:       async () => (await import('./slack.js')).SlackAdapter,
  discord:     async () => (await import('./discord.js')).DiscordAdapter,
  google_chat: async () => (await import('./google_chat.js')).GoogleChatAdapter,
  teams:       async () => (await import('./teams.js')).TeamsAdapter,
  webchat:     async () => (await import('./webchat.js')).WebChatAdapter,
};

/**
 * Manages all channel adapters: dynamically loads enabled ones, routes outbound messages.
 *
 * Hooks: optional per-channel setup functions called after construction but before init().
 * Used for channels like webchat that need extra configuration (e.g. setMeta).
 */
export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private handlers: Array<(event: ANPEvent) => void> = [];

  async init(
    config: GatewayConfig,
    hooks?: Record<string, (adapter: ChannelAdapter) => void>,
  ): Promise<void> {
    for (const [name, channelCfg] of Object.entries(config.channels)) {
      const cfg = channelCfg as ChannelConfig | undefined;
      if (!cfg?.enabled) continue;

      const factory = CHANNEL_REGISTRY[name];
      if (!factory) {
        console.warn(`[Channels] Unknown channel "${name}" — add it to CHANNEL_REGISTRY in manager.ts`);
        continue;
      }

      try {
        const AdapterClass = await factory();
        const adapter      = new AdapterClass();

        // Run optional pre-init hook (e.g. webchat.setMeta)
        hooks?.[name]?.(adapter);

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
