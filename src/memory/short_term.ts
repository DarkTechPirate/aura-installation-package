import type { LLMMessage } from '../llm/types.js';

const MAX_TURNS            = 20;
const TTL_TRANSIENT_MS     = 2  * 60 * 60 * 1000;  // 2 hours  — webchat / realtime (UUID sessions)
const TTL_STABLE_MS        = 30 * 24 * 60 * 60 * 1000; // 30 days — telegram / slack / discord

/** UUID format = transient session (webchat, realtime). Everything else is stable (telegram_xxx etc.). */
function isStableSession(session_id: string): boolean {
  return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session_id);
}

/**
 * Per-session RAM ring buffer for recent conversation turns.
 * Stable sessions (Telegram, Slack, Discord) persist for 30 days.
 * Transient sessions (webchat, realtime) expire after 2 hours of inactivity.
 * Automatically trims to MAX_TURNS when capacity exceeded.
 */
export class ShortTermMemory {
  private sessions = new Map<string, LLMMessage[]>();
  private lastSeen = new Map<string, number>();

  addTurn(
    session_id: string,
    role: 'user' | 'assistant',
    content: string,
    tool_call_id?: string
  ): void {
    if (!this.sessions.has(session_id)) {
      this.sessions.set(session_id, []);
    }
    const msgs = this.sessions.get(session_id)!;
    msgs.push({
      role,
      content,
      ...(tool_call_id ? { tool_call_id } : {}),
    });
    // Keep only last MAX_TURNS
    if (msgs.length > MAX_TURNS) {
      msgs.splice(0, msgs.length - MAX_TURNS);
    }
    this.lastSeen.set(session_id, Date.now());
  }

  get(session_id: string): LLMMessage[] {
    this.lastSeen.set(session_id, Date.now());
    return this.sessions.get(session_id) ?? [];
  }

  clear(session_id: string): void {
    this.sessions.delete(session_id);
    this.lastSeen.delete(session_id);
  }

  /** Remove sessions that have exceeded their TTL based on session type. */
  cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.lastSeen) {
      const ttl = isStableSession(id) ? TTL_STABLE_MS : TTL_TRANSIENT_MS;
      if (now - ts > ttl) {
        this.sessions.delete(id);
        this.lastSeen.delete(id);
      }
    }
  }
}
