import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import crypto from 'crypto';
import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { ANPEvent } from '../anp/types.js';

/**
 * Signal channel adapter using signal-cli (Java binary) over JSON-RPC stdio.
 * node_id format: signal_<phone_number>
 * Requires Java 17+ and signal-cli at the configured path.
 * SIGNAL_PHONE_NUMBER env var — never hardcoded.
 */
export class SignalAdapter implements ChannelAdapter {
  readonly channel_id = 'signal';
  private proc: ChildProcessWithoutNullStreams | null = null;
  private handlers: Array<(event: ANPEvent) => void> = [];
  private phoneNumber = '';
  private buffer = '';
  private rpcId = 0;

  async init(config: ChannelConfig): Promise<void> {
    const phone = config['phone_number'] as string | undefined ?? process.env['SIGNAL_PHONE_NUMBER'];
    const cliPath = config['signal_cli'] as string | undefined ?? '/usr/local/bin/signal-cli';

    if (!phone) throw new Error('Signal phone_number required (or SIGNAL_PHONE_NUMBER env)');
    this.phoneNumber = phone;

    // Launch signal-cli in JSON-RPC daemon mode
    this.proc = spawn(cliPath, [
      '--account', phone,
      '--output', 'json',
      'jsonRpc',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.proc.stderr.on('data', (d: Buffer) =>
      console.error('[Signal] stderr:', d.toString().trim())
    );

    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.handleLine(line.trim());
      }
    });

    this.proc.on('exit', (code) =>
      console.warn('[Signal] signal-cli exited with code:', code)
    );

    // Subscribe to incoming messages
    this.sendRpc('subscribeReceive', {});
    console.log('[Signal] Adapter started for', phone);
  }

  private sendRpc(method: string, params: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params });
    this.proc.stdin.write(msg + '\n');
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    // JSON-RPC notification (incoming message event)
    const method = msg['method'] as string | undefined;
    if (method !== 'receive') return;

    const params = msg['params'] as Record<string, unknown> | undefined;
    const envelope = params?.['envelope'] as Record<string, unknown> | undefined;
    const dataMsg = envelope?.['dataMessage'] as Record<string, unknown> | undefined;
    const from = String(envelope?.['sourceNumber'] ?? '').replace('+', '');
    const text = String(dataMsg?.['message'] ?? '').trim();

    if (!from || !text) return;

    const node_id = `signal_${from}`;
    const event: ANPEvent = {
      type: 'event', event: 'utterance',
      node_id, session_id: crypto.randomUUID(),
      ts: Date.now(),
      payload: { text, routing_hint: 'simple' },
    };
    for (const h of this.handlers) h(event);
  }

  onMessage(handler: (event: ANPEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    const recipient = '+' + message.node_id.replace('signal_', '');
    this.sendRpc('send', { recipient: [recipient], message: message.text });
  }

  async isHealthy(): Promise<boolean> {
    return this.proc !== null && !this.proc.killed;
  }

  async destroy(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
  }
}
