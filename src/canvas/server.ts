import { WebSocketServer, WebSocket } from 'ws';
import type { GatewayConfig } from '../config/loader.js';
import type { CanvasEvent } from './types.js';
import { CanvasRenderer } from './renderer.js';

/**
 * WebSocket server for live Canvas updates on port 3001.
 * Protocol: ws://127.0.0.1:3001/canvas
 *
 * On connect: sends full current state as {event:'state', blocks:[...]}
 * On agent action: broadcasts incremental events (append/update/delete/clear)
 */
export class CanvasServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private renderer: CanvasRenderer;
  private config: GatewayConfig;

  constructor(renderer: CanvasRenderer, config: GatewayConfig) {
    this.renderer = renderer;
    this.config = config;

    // Broadcast on every renderer change
    renderer.onChange(() => {
      // The actual event is broadcast explicitly by callers via broadcast()
    });
  }

  async start(): Promise<void> {
    const { bind_address } = this.config.security;
    const port = this.config.canvas.port;

    this.wss = new WebSocketServer({ host: bind_address, port, path: '/canvas' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);

      // Send full state on connect
      const stateEvent: CanvasEvent = { event: 'state', blocks: this.renderer.getBlocks() };
      ws.send(JSON.stringify(stateEvent));

      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });

    this.wss.on('error', (err) => console.error('[Canvas] Server error:', err));
    console.log(`[Canvas] Server listening on ${bind_address}:${port}/canvas`);
  }

  broadcast(event: CanvasEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    console.log('[Canvas] Server stopped');
  }
}
