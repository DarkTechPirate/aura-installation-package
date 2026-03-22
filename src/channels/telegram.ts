import type { ChannelAdapter, ChannelConfig, OutboundMessage } from './interface.js';
import type { ANPEvent, IncomingAttachment, UtterancePayload } from '../anp/types.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const WORKSPACE_DIR = path.join(os.homedir(), '.aura', 'workspace');

/**
 * Telegram channel adapter using Telegraf.
 * node_id format: telegram_<chat_id>
 *
 * Outgoing: uses Telegraf's bot.telegram.sendMessage (short HTTP call — works everywhere).
 * Incoming: uses native fetch for long-polling getUpdates, bypassing Telegraf's bundled
 *           node-fetch which fails in WSL2 due to keepAlive + long-lived socket issues.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly channel_id = 'telegram';
  private bot: unknown = null;
  private handlers: Array<(event: ANPEvent) => void> = [];
  private allowedIds = new Set<string>();
  private polling   = false;
  private offset    = 0;
  private token     = '';

  async init(config: ChannelConfig): Promise<void> {
    this.token = config['token'] as string ?? '';
    if (!this.token) throw new Error('Telegram token required');

    // Build allowlist — if empty, all IDs are blocked
    const raw = config['allowed_ids'] as (number | string)[] | undefined;
    this.allowedIds = new Set((raw ?? []).map(String));
    if (this.allowedIds.size === 0) {
      console.warn('[Telegram] WARNING: no allowed_ids configured — all messages will be ignored');
    } else {
      console.log(`[Telegram] Allowlist: ${[...this.allowedIds].join(', ')}`);
    }

    // Telegraf is used ONLY for outgoing sendMessage (short HTTP requests work fine)
    const { Telegraf } = await import('telegraf');
    this.bot = new Telegraf(this.token);

    // Clear any stale webhook / pending updates so polling starts clean
    await this.apiCall('deleteWebhook', { drop_pending_updates: true }).catch(() => {});

    // Start native-fetch polling loop
    this.polling = true;
    this.pollLoop();
    console.log('[Telegram] Bot started');
  }

  /** Thin wrapper around the Bot API using native fetch — retries up to 3x on network errors. */
  private async apiCall(method: string, body: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<unknown> {
    const url     = `https://api.telegram.org/bot${this.token}/${method}`;
    const MAX_TRIES = 3;

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
          body:    JSON.stringify(body),
          signal:  AbortSignal.timeout(timeoutMs),
        });
        const data = await res.json() as { ok: boolean; result: unknown; description?: string };
        if (!res.ok || !data.ok) {
          // Telegram API error — no point retrying (e.g. 400 Bad Request)
          throw new Error(`Telegram ${method} HTTP ${res.status}: ${data.description ?? 'unknown'}`);
        }
        return data.result;
      } catch (err) {
        const isNetworkError = !(err instanceof Error && err.message.startsWith('Telegram '));
        // getUpdates has its own retry loop — don't double-retry it here
        // sendChatAction is cosmetic (typing indicator) — fail fast, never retry
        if (!isNetworkError || attempt === MAX_TRIES || method === 'getUpdates' || method === 'sendChatAction') throw err;
        const delay = attempt * 2000; // 2s, 4s
        console.warn(`[Telegram] ${method} failed (attempt ${attempt}/${MAX_TRIES}), retrying in ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error(`[Telegram] ${method} failed after ${MAX_TRIES} attempts`);
  }

  /** Long-polling loop using native fetch — never touches node-fetch */
  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const updates = await this.apiCall('getUpdates', {
          offset:  this.offset,
          timeout: 15,          // shorter than WSL2 socket keepalive to avoid ETIMEDOUT
          allowed_updates: ['message'],
        }, 20_000) as Array<Record<string, unknown>>; // 20s abort > 15s long-poll

        for (const update of updates) {
          const updateId = update['update_id'] as number;
          this.offset = updateId + 1;
          this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.polling) break;
        // Brief pause on error then retry — keeps the loop alive through transient failures
        const cause = (err instanceof Error && (err as NodeJS.ErrnoException).cause)
          ? ` (cause: ${String((err as NodeJS.ErrnoException).cause)})`
          : '';
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[Telegram] Poll error (retrying in 5s):', msg + cause);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  /** Download a Telegram file by file_id and return it as a base64 string. */
  private async downloadFileAsBase64(file_id: string): Promise<string> {
    const meta = await this.apiCall('getFile', { file_id }) as { file_path: string };
    const url  = `https://api.telegram.org/file/bot${this.token}/${meta.file_path}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Telegram file download HTTP ${res.status}`);
    const buf  = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  }

  private handleUpdate(update: Record<string, unknown>): void {
    const msg    = update['message'] as Record<string, unknown> | undefined;
    const chat   = msg?.['chat'] as Record<string, unknown> | undefined;
    const chatId = String(chat?.['id'] ?? '');
    if (!chatId) return;

    if (!this.allowedIds.has(chatId)) {
      console.warn(`[Telegram] Blocked message from unauthorized ID: ${chatId}`);
      return;
    }

    // Fire async handling so the poll loop isn't blocked waiting for downloads
    this.handleMessageAsync(msg, chatId).catch(err =>
      console.error('[Telegram] handleUpdate error:', err)
    );
  }

  private async handleMessageAsync(
    msg: Record<string, unknown> | undefined,
    chatId: string,
  ): Promise<void> {
    if (!msg) return;

    const caption = (msg['caption'] as string | undefined) ?? '';
    const text    = (msg['text'] as string | undefined) ?? caption;

    // ── Photo ────────────────────────────────────────────────────────────────
    // Telegram sends photos as array sorted smallest→largest; use the last one.
    const photos = msg['photo'] as Array<Record<string, unknown>> | undefined;
    if (photos && photos.length > 0) {
      const best    = photos[photos.length - 1];
      const file_id = best['file_id'] as string;
      let image_b64: string | undefined;
      try {
        image_b64 = await this.downloadFileAsBase64(file_id);
      } catch (err) {
        console.error('[Telegram] Photo download failed:', err);
      }
      const payload: UtterancePayload = {
        text:         text || '(user sent a photo)',
        image_b64:    image_b64 ?? null,
        routing_hint: 'vision',
      };
      this.emit(chatId, payload);
      return;
    }

    // ── Non-image attachments ─────────────────────────────────────────────────
    // Download the file to ~/.aura/workspace/ so Gary can access it directly.
    const attachmentTypes: Array<[string, IncomingAttachment['type']]> = [
      ['document', 'document'],
      ['audio',    'audio'],
      ['video',    'video'],
      ['voice',    'voice'],
      ['sticker',  'sticker'],
    ];
    for (const [key, attType] of attachmentTypes) {
      const media = msg[key] as Record<string, unknown> | undefined;
      if (!media) continue;

      const file_id   = media['file_id'] as string | undefined;
      const rawName   = (media['file_name'] ?? media['title']) as string | undefined;
      const mime_type = media['mime_type'] as string | undefined;

      // Download to workspace so the agent can read/analyse it
      let savedPath: string | undefined;
      if (file_id) {
        try {
          const meta     = await this.apiCall('getFile', { file_id }) as { file_path: string };
          const fileUrl  = `https://api.telegram.org/file/bot${this.token}/${meta.file_path}`;
          const res      = await fetch(fileUrl);
          if (res.ok) {
            if (!fs.existsSync(WORKSPACE_DIR)) fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
            // Use original filename if available, otherwise derive from Telegram path
            const filename = rawName ?? path.basename(meta.file_path);
            savedPath = path.join(WORKSPACE_DIR, filename);
            const buf = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(savedPath, buf);
            console.log(`[Telegram] Saved ${attType} → ${savedPath}`);
          }
        } catch (err) {
          console.error(`[Telegram] Failed to download ${attType}:`, err);
        }
      }

      const att: IncomingAttachment = {
        type: attType,
        file_id,
        filename:  rawName,
        mime_type,
        caption:   caption || undefined,
      };

      // Tell the agent exactly where the file landed so it can act on it
      const locationHint = savedPath
        ? `\nThe file has been saved to your workspace at: ${savedPath}`
        : '';
      const payload: UtterancePayload = {
        text:         (text || `User sent a ${attType}${rawName ? ': ' + rawName : ''}`) + locationHint,
        attachments:  [att],
        routing_hint: 'complex', // file analysis needs a capable model
      };
      this.emit(chatId, payload);
      return;
    }

    // ── Plain text ────────────────────────────────────────────────────────────
    if (!text) return; // ignore unsupported message types (stickers without file_id, etc.)
    this.emit(chatId, { text, routing_hint: 'simple' });
  }

  private emit(chatId: string, payload: UtterancePayload): void {
    const event: ANPEvent = {
      type:       'event',
      event:      'utterance',
      node_id:    `telegram_${chatId}`,
      session_id: `telegram_${chatId}`,  // stable per-user so short-term memory persists
      ts:         Date.now(),
      payload,
    };
    for (const h of this.handlers) h(event);
  }

  onMessage(handler: (event: ANPEvent) => void): void {
    this.handlers.push(handler);
  }

  /** Strip markdown formatting to clean plain text for Telegram (no parse_mode). */
  private stripMarkdown(text: string): string {
    return text
      .replace(/^#{1,6}\s+/gm, '')             // ## Heading → Heading
      .replace(/\*\*\*(.+?)\*\*\*/gs, '$1')    // ***bold italic*** → text
      .replace(/\*\*(.+?)\*\*/gs, '$1')        // **bold** → text
      .replace(/__(.+?)__/gs, '$1')             // __bold__ → text
      .replace(/\*(.+?)\*/gs, '$1')             // *italic* → text
      .replace(/_([^_]+)_/gs, '$1')             // _italic_ → text
      .replace(/~~(.+?)~~/gs, '$1')             // ~~strike~~ → text
      .replace(/```[\s\S]*?```/g, m => {        // ```code block``` → code block
        return m.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      })
      .replace(/`([^`]+)`/g, '$1')              // `inline code` → text
      .replace(/^\s*[-*+]\s+/gm, '• ')          // - list item → • list item
      .replace(/^\s*\d+\.\s+/gm, (m, o, s) => m) // keep numbered lists as-is
      .replace(/^>\s+/gm, '')                   // > blockquote → text
      .replace(/^-{3,}$/gm, '─────────────')   // --- → line
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
      .replace(/\n{3,}/g, '\n\n')               // collapse excess blank lines
      .trim();
  }

  async send(message: OutboundMessage): Promise<void> {
    const chatId = message.node_id.replace('telegram_', '');

    // Send any attachments first (photo, document, audio, video, etc.)
    for (const att of message.attachments ?? []) {
      const caption = att.caption?.slice(0, 1024);
      const common  = { chat_id: chatId, ...(caption ? { caption } : {}) };
      switch (att.type) {
        case 'photo':     await this.apiCall('sendPhoto',     { ...common, photo:     att.url }); break;
        case 'document':  await this.apiCall('sendDocument',  { ...common, document:  att.url, ...(att.filename ? { filename: att.filename } : {}) }); break;
        case 'audio':     await this.apiCall('sendAudio',     { ...common, audio:     att.url }); break;
        case 'video':     await this.apiCall('sendVideo',     { ...common, video:     att.url }); break;
        case 'voice':     await this.apiCall('sendVoice',     { ...common, voice:     att.url }); break;
        case 'animation': await this.apiCall('sendAnimation', { ...common, animation: att.url }); break;
        default: console.warn('[Telegram] Unknown attachment type:', (att as { type: string }).type);
      }
    }

    // Send text if present
    const text = this.stripMarkdown(message.text?.trim() ?? '');
    if (!text) return;
    // Telegram max message length is 4096 chars
    const safeText = text.length > 4096 ? text.slice(0, 4090) + '…' : text;
    await this.apiCall('sendMessage', { chat_id: chatId, text: safeText });
  }

  /** Send a "typing…" chat action — Telegram shows it for ~5 s so must be refreshed periodically. */
  async sendTyping(node_id: string): Promise<void> {
    const chatId = node_id.replace('telegram_', '');
    await this.apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }

  async isHealthy(): Promise<boolean> {
    return this.bot !== null && this.polling;
  }

  async destroy(): Promise<void> {
    this.polling = false;
    this.bot     = null;
  }
}
