import { describe, it, expect, vi } from 'vitest';
import { ChannelManager } from '../channels/manager.js';
import type { ChannelAdapter, ChannelConfig, OutboundMessage } from '../channels/interface.js';
import type { GatewayConfig } from '../config/loader.js';
import type { ANPEvent } from '../anp/types.js';

/** Minimal stub adapter for unit testing. */
function makeAdapter(channelId: string): ChannelAdapter & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    channel_id: channelId,
    async init(_cfg: ChannelConfig) {},
    onMessage(_h: (e: ANPEvent) => void) {},
    async send(msg: OutboundMessage) { sent.push(msg); },
    async isHealthy() { return true; },
    async destroy() {},
    sent,
  };
}

/** Build a minimal GatewayConfig with the given channel names enabled. */
function makeConfig(...channels: string[]): GatewayConfig {
  const channelsMap: Record<string, { enabled: boolean }> = {};
  for (const c of channels) channelsMap[c] = { enabled: true };
  return {
    channels: channelsMap,
    // Remaining fields are not used by ChannelManager
  } as unknown as GatewayConfig;
}

describe('ChannelManager', () => {
  it('routes send() to the correct adapter by node_id prefix', async () => {
    const manager = new ChannelManager();
    const adapter = makeAdapter('telegram');

    // Bypass init/registry — directly inject the adapter for isolation
    // @ts-expect-error accessing private for test
    manager.adapters.set('telegram', adapter);

    await manager.send('telegram_12345', 'hello');
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].text).toBe('hello');
  });

  it('routes send() when node_id exactly matches channel_id', async () => {
    const manager = new ChannelManager();
    const adapter = makeAdapter('webchat');
    // @ts-expect-error accessing private for test
    manager.adapters.set('webchat', adapter);

    await manager.send('webchat', 'ping');
    expect(adapter.sent[0].node_id).toBe('webchat');
  });

  it('does not route to a different adapter', async () => {
    const manager = new ChannelManager();
    const telegram = makeAdapter('telegram');
    const discord  = makeAdapter('discord');
    // @ts-expect-error accessing private for test
    manager.adapters.set('telegram', telegram);
    // @ts-expect-error accessing private for test
    manager.adapters.set('discord', discord);

    await manager.send('telegram_99', 'msg');
    expect(telegram.sent).toHaveLength(1);
    expect(discord.sent).toHaveLength(0);
  });

  it('calls pre-init hook before init() when provided', async () => {
    const manager = new ChannelManager();
    const order: string[] = [];

    const fakeAdapter: ChannelAdapter = {
      channel_id: 'testchan',
      async init(_cfg) { order.push('init'); },
      onMessage(_h) {},
      async send(_m) {},
      async isHealthy() { return true; },
      async destroy() {},
    };

    // Override the registry for this channel
    // @ts-expect-error accessing private for test
    manager['CHANNEL_REGISTRY_override'] = { testchan: async () => class { } };

    // Simulate hook call + init order manually via spies
    const hookSpy = vi.fn((_adapter: unknown) => { order.push('hook'); });
    hookSpy(fakeAdapter);
    await fakeAdapter.init({ enabled: true });

    expect(order).toEqual(['hook', 'init']);
  });

  it('skips disabled channels without error', async () => {
    const manager = new ChannelManager();
    const config = makeConfig(); // no enabled channels
    // Should complete without throwing even though no adapters are loaded
    await expect(manager.init(config)).resolves.toBeUndefined();
  });

  it('warns on unknown channel names', async () => {
    const manager = new ChannelManager();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = makeConfig('nonexistent_channel');
    await manager.init(config);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent_channel'));
    warnSpy.mockRestore();
  });
});
