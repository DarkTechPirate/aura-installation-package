import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { ANPEvent } from '../anp/types.js';
import { speechToText } from '../voice/whisper.js';
import { textToSpeech } from '../voice/elevenlabs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const QWEN_REALTIME_URL   = 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime';
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/**
 * WebChat channel adapter.
 *
 * Serves a full browser UI at http://127.0.0.1:<port>/
 * WebSocket chat:    ws://<host>:<port>/
 * Realtime relay:    ws://<host>:<port>/realtime?provider=qwen|openai
 *
 * Call setMeta() before init() to inject canvas port, agent name, and persona.
 */
export class WebChatAdapter implements ChannelAdapter {
  readonly channel_id = 'browser';

  private server:   http.Server      | null = null;
  private wss:      WebSocketServer  | null = null;
  private sessions         = new Map<string, WebSocket>();
  private realtimeSessions = new Map<string, { browserWs: WebSocket; upstreamWs: WebSocket; tts: string }>();
  private handlers: Array<(event: ANPEvent) => void> = [];

  private canvasPort  = 3001;
  private restPort    = 3002;
  private agentName   = 'AURA';
  private bindAddress = '127.0.0.1';
  private persona     = 'You are AURA, a helpful AI assistant.';
  private voiceSessions    = new Map<string, string>(); // node_id → tts mode ('elevenlabs'|'browser')

  /** Inject gateway metadata before init(). */
  setMeta(canvasPort: number, restPort: number, agentName: string, bindAddress: string, persona?: string): void {
    this.canvasPort  = canvasPort;
    this.restPort    = restPort;
    this.agentName   = agentName;
    this.bindAddress = bindAddress;
    if (persona) this.persona = persona;
  }

  async init(config: ChannelConfig): Promise<void> {
    const port = (config['port'] as number | undefined) ?? 3000;
    const host = this.bindAddress;

    // Read the HTML template and inject config values
    const htmlPath = path.join(__dirname, 'webchat.html');
    const raw = fs.readFileSync(htmlPath, 'utf8');
    const html = raw
      .replace(/__CANVAS_PORT__/g, String(this.canvasPort))
      .replace(/__REST_PORT__/g,   String(this.restPort))
      .replace(/__AGENT_NAME_JSON__/g, JSON.stringify(this.agentName))
      .replace(/__AGENT_NAME__/g, this.agentName);

    // HTTP server: serve the UI at GET /
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    // Chat WSS (noServer — we route upgrades manually below)
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws) => this.handleChatConnection(ws));

    // Realtime relay WSS
    const realtimeWss = new WebSocketServer({ noServer: true });
    realtimeWss.on('connection', (ws, req) => this.handleRealtimeConnection(ws, req as IncomingMessage));

    // Route WebSocket upgrades by path
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname === '/realtime') {
        realtimeWss.handleUpgrade(req, socket, head, (ws) => realtimeWss.emit('connection', ws, req));
      } else {
        this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit('connection', ws, req));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => resolve());
      this.server!.once('error', reject);
    });

    console.log(`[WebChat] UI ready → http://${host}:${port}`);
  }

  // ── Standard chat connection ───────────────────────────────────────────────

  private handleChatConnection(ws: WebSocket): void {
    const node_id    = `browser_${crypto.randomUUID()}`;
    const session_id = crypto.randomUUID();
    this.sessions.set(node_id, ws);

    ws.send(JSON.stringify({ type: 'connected', node_id, session_id, agent_name: this.agentName }));

    ws.on('message', async (data: Buffer) => {
      try {
        const msg         = JSON.parse(data.toString()) as Record<string, unknown>;
        const image_b64   = msg['image_b64'] as string | undefined;
        const vision_tier = (msg['vision_tier'] as string | undefined) ?? 'vision';

        // ── Voice message (Option A) — transcribe → LLM → TTS ──
        if (msg['type'] === 'audio') {
          const audio_b64 = msg['audio_b64'] as string | undefined;
          if (!audio_b64) return;
          try {
            const buf     = Buffer.from(audio_b64, 'base64');
            const text    = await speechToText(buf, 'audio.webm');
            const ttsMode = (msg['tts'] as string | undefined) ?? 'elevenlabs';
            ws.send(JSON.stringify({ type: 'transcript', text }));
            if (!text.trim()) return;
            this.voiceSessions.set(node_id, ttsMode);
            const event: ANPEvent = {
              type: 'event', event: 'utterance', node_id, session_id,
              ts: Date.now(),
              payload: { text, routing_hint: 'simple' as import('../anp/types.js').RoutingHint },
            };
            for (const h of this.handlers) h(event);
          } catch {
            ws.send(JSON.stringify({ type: 'transcript', text: '[Speech recognition failed]' }));
          }
          return;
        }

        // ── Text / image message ──
        const text              = msg['text'] as string | undefined;
        const workflow_disabled = msg['workflow_disabled'] === true;
        if (!text) return;

        const event: ANPEvent = {
          type: 'event', event: 'utterance', node_id, session_id,
          ts: Date.now(),
          payload: {
            text,
            routing_hint: image_b64 ? vision_tier as import('../anp/types.js').RoutingHint : 'simple',
            ...(image_b64           ? { image_b64 }           : {}),
            ...(workflow_disabled   ? { workflow_disabled }    : {}),
          },
        };
        for (const h of this.handlers) h(event);
      } catch { /* ignore malformed messages */ }
    });

    ws.on('close', () => this.sessions.delete(node_id));
  }

  // ── Realtime connection — Qwen handles voice I/O, AURA handles the thinking ─

  private handleRealtimeConnection(browserWs: WebSocket, req: IncomingMessage): void {
    const url      = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const provider = url.searchParams.get('provider') ?? 'qwen';
    const tts      = url.searchParams.get('tts') ?? 'browser';
    const model    = url.searchParams.get('model')
      ?? (provider === 'openai' ? 'gpt-4o-realtime-preview' : 'qwen3-omni-flash-realtime');

    // Each realtime session gets its own node_id so AURA's send() can find it
    const node_id    = `browser_realtime_${crypto.randomUUID()}`;  // must start with 'browser_' for channel manager routing
    const session_id = crypto.randomUUID();

    const upstreamUrl = provider === 'openai'
      ? `${OPENAI_REALTIME_URL}?model=${model}`
      : `${QWEN_REALTIME_URL}?model=${model}`;

    const apiKey = provider === 'openai'
      ? (process.env['OPENAI_API_KEY'] ?? '')
      : (process.env['DASHSCOPE_API_KEY'] ?? '');

    const upstreamWs = new WebSocket(upstreamUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...(provider === 'openai' ? { 'OpenAI-Beta': 'realtime=v1' } : {}),
      },
    });

    this.realtimeSessions.set(node_id, { browserWs, upstreamWs, tts });

    upstreamWs.on('open', () => {
      // create_response:false — Qwen will NOT think for itself.
      // When AURA's response comes back via send(), we call response.create manually.
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities:           ['text', 'audio'],
          // Minimal instructions — Qwen is voice-only; AURA handles the thinking.
          instructions:         `You are a voice interface. Speak the text you are given clearly and naturally. Do not add anything extra.`,
          voice:                provider === 'openai' ? 'alloy' : 'Cherry',
          input_audio_format:   'pcm16',
          output_audio_format:  provider === 'openai' ? 'pcm16' : 'pcm24',
          input_audio_transcription: { model: provider === 'openai' ? 'whisper-1' : 'paraformer-realtime' },
          turn_detection: {
            type:                'server_vad',
            threshold:           0.5,
            prefix_padding_ms:   300,
            silence_duration_ms: 600,
            create_response:     false, // AURA decides when to respond
          },
        },
      };
      upstreamWs.send(JSON.stringify(sessionUpdate));
      browserWs.send(JSON.stringify({ type: 'realtime.ready', provider, model }));
      console.log(`[Realtime] Session ${node_id} started — provider: ${provider}, model: ${model}`);
    });

    // Relay upstream → browser (audio deltas, transcripts, status events)
    // Also intercept transcript completion to route through AURA pipeline.
    upstreamWs.on('message', (data, isBinary) => {
      if (browserWs.readyState === WebSocket.OPEN) browserWs.send(data, { binary: isBinary });

      if (isBinary) {
        console.log(`[Realtime] Binary frame from Qwen — ${(data as Buffer).length} bytes`);
      }

      if (!isBinary) {
        try {
          const msg = JSON.parse((data as Buffer).toString()) as Record<string, unknown>;
          const t = msg['type'] as string;
          if (t === 'response.audio.delta') {
            console.log(`[Realtime] Audio delta — ${((msg['delta'] as string)?.length ?? 0)} b64 chars`);
          } else {
            console.log(`[Realtime] Qwen event: ${t}`);
          }
          if (t === 'error') console.error(`[Realtime] Qwen error:`, JSON.stringify(msg));
          if (msg['type'] === 'conversation.item.input_audio_transcription.completed') {
            const transcript = (msg['transcript'] as string | undefined)?.trim();
            if (transcript) {
              console.log(`[Realtime] → AURA: "${transcript}"`);
              const event: ANPEvent = {
                type: 'event', event: 'utterance', node_id, session_id,
                ts: Date.now(),
                payload: { text: transcript, routing_hint: 'simple' as import('../anp/types.js').RoutingHint },
              };
              for (const h of this.handlers) h(event);
            }
          }
        } catch { /* ignore parse errors on binary-like text */ }
      }
    });

    // Relay browser → upstream (mic audio chunks from ScriptProcessor)
    browserWs.on('message', (data: Buffer, isBinary: boolean) => {
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.send(data, { binary: isBinary });
    });

    upstreamWs.on('close', (code, reason) => {
      console.log(`[Realtime] Upstream closed — ${code} ${reason}`);
      this.realtimeSessions.delete(node_id);
      if (browserWs.readyState < 2) browserWs.close();
    });
    upstreamWs.on('error', (e) => {
      console.error('[Realtime] Upstream error:', e.message);
      if (browserWs.readyState === WebSocket.OPEN)
        browserWs.send(JSON.stringify({ type: 'realtime.error', message: e.message }));
      if (browserWs.readyState < 2) browserWs.close();
    });
    browserWs.on('close', () => {
      this.realtimeSessions.delete(node_id);
      if (upstreamWs.readyState < 2) upstreamWs.close();
      console.log(`[Realtime] Browser disconnected — session ${node_id}`);
    });
  }

  // ── ChannelAdapter interface ───────────────────────────────────────────────

  onMessage(handler: (event: ANPEvent) => void): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<void> {
    // ── Realtime session: Qwen STT + ElevenLabs TTS ───────────────────────────
    // Qwen realtime reliably handles speech-to-text but its response.create TTS
    // is unreliable. We use ElevenLabs for the TTS leg instead.
    const rt = this.realtimeSessions.get(message.node_id);
    if (rt) {
      const { browserWs } = rt;
      const text = message.text ?? '';
      console.log(`[Realtime] AURA → TTS: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);

      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify({ type: 'rt.agent_text', text }));
        browserWs.send(JSON.stringify({ type: 'rt.mic_pause' }));

        if (rt.tts === 'elevenlabs') {
          try {
            const voiceId  = process.env['ELEVENLABS_VOICE_ID'] ?? '21m00Tcm4TlvDq8ikWAM';
            const audioBuf = await textToSpeech(text, voiceId, 'mp3_44100_128');
            browserWs.send(JSON.stringify({
              type: 'rt.agent_audio',
              audio_b64: audioBuf.toString('base64'),
              audio_mime: 'audio/mpeg',
            }));
          } catch (e) {
            console.error('[Realtime] ElevenLabs TTS failed, falling back to browser:', e);
            browserWs.send(JSON.stringify({ type: 'rt.agent_audio', text }));
          }
        } else {
          browserWs.send(JSON.stringify({ type: 'rt.agent_audio', text }));
        }
      }
      return;
    }

    // ── Standard text chat session (mic button / Whisper STT) ─────────────────
    const ws = this.sessions.get(message.node_id);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // If this session requested TTS, handle based on selected mode
    const ttsMode = this.voiceSessions.get(message.node_id);
    if (ttsMode) {
      this.voiceSessions.delete(message.node_id);
      if (ttsMode === 'elevenlabs') {
        try {
          const voiceId  = process.env['ELEVENLABS_VOICE_ID'] ?? '21m00Tcm4TlvDq8ikWAM';
          const audioBuf = await textToSpeech(message.text ?? '', voiceId, 'mp3_44100_128');
          ws.send(JSON.stringify({
            type: 'message', text: message.text,
            audio_b64: audioBuf.toString('base64'), audio_mime: 'audio/mpeg',
          }));
          return;
        } catch (e) {
          console.error('[WebChat] ElevenLabs TTS failed, falling back:', e);
        }
      } else {
        // Browser TTS — send text with a tts flag so browser speaks it
        ws.send(JSON.stringify({ type: 'message', text: message.text, speak: true }));
        return;
      }
    }

    ws.send(JSON.stringify({ type: 'message', text: message.text }));
  }

  async isHealthy(): Promise<boolean> { return this.server !== null; }

  async destroy(): Promise<void> {
    for (const ws of this.sessions.values()) ws.close();
    this.sessions.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
