import type { ChannelAdapter, ChannelConfig, MediaAttachment } from './interface.js';
import type { ANPEvent } from '../anp/types.js';
import type { GatewayConfig } from '../config/loader.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Channels');

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
const HEALTH_INTERVAL_MS   = 60_000; // poll every 60 s
const HEALTH_FAIL_THRESHOLD = 3;      // mark degraded after 3 consecutive failures

export class ChannelManager {
  private adapters      = new Map<string, ChannelAdapter>();
  private handlers:     Array<(event: ANPEvent) => void> = [];
  private failCounts    = new Map<string, number>();
  private healthTimer:  ReturnType<typeof setInterval> | null = null;

  async init(
    config: GatewayConfig,
    hooks?: Record<string, (adapter: ChannelAdapter) => void>,
  ): Promise<void> {
    for (const [name, channelCfg] of Object.entries(config.channels)) {
      const cfg = channelCfg as ChannelConfig | undefined;
      if (!cfg?.enabled) continue;

      const factory = CHANNEL_REGISTRY[name];
      if (!factory) {
        logger.warn(`Unknown channel — add it to CHANNEL_REGISTRY`, { channel: name });
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
        logger.info('Channel started', { channel: name });
      } catch (err) {
        logger.error('Failed to start channel', { channel: name, error: String(err) });
      }
    }
  }

  /** Start proactive health polling. Call once after init(). */
  startHealthMonitor(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => { this.checkHealth().catch(() => {}); }, HEALTH_INTERVAL_MS);
  }

  private async checkHealth(): Promise<void> {
    for (const [name, adapter] of this.adapters) {
      try {
        const healthy = await adapter.isHealthy();
        if (healthy) {
          if ((this.failCounts.get(name) ?? 0) > 0) {
            logger.info('Channel recovered', { channel: name });
          }
          this.failCounts.set(name, 0);
        } else {
          const fails = (this.failCounts.get(name) ?? 0) + 1;
          this.failCounts.set(name, fails);
          if (fails >= HEALTH_FAIL_THRESHOLD) {
            logger.warn('Channel degraded', { channel: name, consecutive_failures: fails });
          }
        }
      } catch (err) {
        const fails = (this.failCounts.get(name) ?? 0) + 1;
        this.failCounts.set(name, fails);
        logger.warn('Channel health check threw', { channel: name, error: String(err), consecutive_failures: fails });
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
    logger.warn('No adapter found for node_id', { node_id });
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
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    for (const adapter of this.adapters.values()) {
      try { await adapter.destroy(); } catch {}
    }
    this.adapters.clear();
  }
}
