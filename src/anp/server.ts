import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import crypto from 'crypto';
import chokidar from 'chokidar';
import type { ANPHello, ANPWelcome, ANPReject, ANPEvent, ANPPing, ANPPong } from './types.js';
import { validateToken } from './auth.js';
import { loadNodes, loadConfig, type GatewayConfig, AURA_DIR } from '../config/loader.js';
import { eventBus } from './router.js';
import path from 'path';

export interface NodeSessionEntry {
  node_id:      string;
  session_id:   string;
  token:        string;
  caps:         string[];
  meta:         Record<string, unknown>;
  ws:           WebSocket;
  connected_at: number;
}

const HANDSHAKE_TIMEOUT_MS = 5000;

export class ANPServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, NodeSessionEntry>();
  private config: GatewayConfig;
  private watcher: ReturnType<typeof chokidar.watch> | null = null;

  constructor(config: GatewayConfig) {
    super();
    this.setMaxListeners(50);
    this.config = config;
  }

  async start(): Promise<void> {
    const { bind_address, anp_port } = this.config.security;

    this.wss = new WebSocketServer({
      host: bind_address,
      port: anp_port,
      path: '/anp',
    });

    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('error', (err) => console.error('[ANP] Server error:', err));

    // chokidar: watch nodes.yaml for revocation
    const nodesPath = path.join(AURA_DIR, 'nodes.yaml');
    this.watcher = chokidar.watch(nodesPath, { ignoreInitial: true });
    this.watcher.on('change', () => this.revokeRemovedNodes());

    // mDNS advertisement (best-effort)
    this.advertiseMDNS(anp_port);

    console.log(`[ANP] Server listening on ${bind_address}:${anp_port}/anp`);
  }

  private advertiseMDNS(port: number): void {
    // Dynamic import to avoid hard dep issues — mdns may not be available
    import('mdns' as unknown as string).then((mdns: Record<string, unknown>) => {
      type MDNSModule = {
        createAdvertisement: (type: unknown, port: number, opts?: unknown) => { start(): void };
        tcp: (name: string) => unknown;
      };
      const m = mdns as MDNSModule;
      const ad = m.createAdvertisement(m.tcp('aura-gw'), port, { name: 'AURA Gateway' });
      ad.start();
      console.log('[ANP] mDNS advertised _aura-gw._tcp.local:' + port);
    }).catch(() => {
      console.log('[ANP] mDNS not available, skipping advertisement');
    });
  }

  private handleConnection(ws: WebSocket): void {
    let handshaked = false;

    // 5-second handshake timeout
    const timeout = setTimeout(() => {
      if (!handshaked) {
        console.warn('[ANP] Handshake timeout, closing connection');
        ws.close();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on('message', (data: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.close();
        return;
      }

      if (!handshaked) {
        clearTimeout(timeout);
        handshaked = true;
        this.handleHello(ws, msg as ANPHello);
        return;
      }

      this.handleMessage(ws, msg);
    });

    ws.on('close', () => {
      // Remove session by ws reference
      for (const [id, sess] of this.sessions) {
        if (sess.ws === ws) {
          this.sessions.delete(id);
          console.log(`[ANP] Node disconnected: ${id}`);
          break;
        }
      }
    });

    ws.on('error', (err) => console.error('[ANP] WS error:', err));
  }

  private handleHello(ws: WebSocket, msg: ANPHello): void {
    if (!msg || msg.type !== 'hello' || msg.anp !== '1.0') {
      const reject: ANPReject = { type: 'reject', code: 401, reason: 'Invalid HELLO' };
      ws.send(JSON.stringify(reject));
      ws.close();
      return;
    }

    const { node_id, token, caps, meta } = msg;

    if (!validateToken(node_id, token)) {
      const reject: ANPReject = { type: 'reject', code: 401, reason: 'Invalid token' };
      ws.send(JSON.stringify(reject));
      ws.close();
      return;
    }

    if (this.sessions.has(node_id)) {
      const reject: ANPReject = { type: 'reject', code: 409, reason: 'Already connected' };
      ws.send(JSON.stringify(reject));
      ws.close();
      return;
    }

    const session_id = crypto.randomUUID();
    const session: NodeSessionEntry = {
      node_id, session_id, token, caps: caps as string[], meta: meta ?? {},
      ws, connected_at: Date.now(),
    };
    this.sessions.set(node_id, session);

    const welcome: ANPWelcome = {
      type: 'welcome',
      node_id,
      session_id,
      gateway_v: '1.0.0',
      heartbeat_interval_sec: this.config.scheduler.heartbeat_interval_min * 60,
    };
    ws.send(JSON.stringify(welcome));
    console.log(`[ANP] Node connected: ${node_id} (session: ${session_id})`);
  }

  private handleMessage(ws: WebSocket, msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;

    if (m.type === 'ping') {
      const ping = m as unknown as ANPPing;
      const pong: ANPPong = { type: 'pong', ts: ping.ts };
      ws.send(JSON.stringify(pong));
      return;
    }

    if (m.type === 'event') {
      const event = m as unknown as ANPEvent;
      // Find session for this ws
      for (const session of this.sessions.values()) {
        if (session.ws === ws) {
          if (event.event === 'utterance') {
            this.emit('utterance', event, session);
            eventBus.emit('utterance', event, session);
          }
          break;
        }
      }
    }
  }

  sendCommand(node_id: string, cmd: string, payload: unknown): boolean {
    const session = this.sessions.get(node_id);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return false;
    session.ws.send(JSON.stringify({ type: 'command', target: node_id, cmd, payload }));
    return true;
  }

  getConnectedNodes(): Map<string, NodeSessionEntry> {
    return this.sessions;
  }

  isConnected(node_id: string): boolean {
    return this.sessions.has(node_id);
  }

  private revokeRemovedNodes(): void {
    const config = loadNodes();
    const validIds = new Set(config.nodes.map(n => n.id));
    for (const [node_id, session] of this.sessions) {
      if (!validIds.has(node_id)) {
        console.log(`[ANP] Revoking node: ${node_id}`);
        setTimeout(() => {
          session.ws.close();
          this.sessions.delete(node_id);
        }, 5000);
      }
    }
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    for (const session of this.sessions.values()) {
      session.ws.close();
    }
    this.sessions.clear();
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });
    console.log('[ANP] Server stopped');
  }
}
