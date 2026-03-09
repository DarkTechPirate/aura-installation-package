import type { ANPEvent } from '../anp/types.js';

export interface ChannelAdapter {
  readonly channel_id: string;
  init(config: ChannelConfig): Promise<void>;
  onMessage(handler: (event: ANPEvent) => void): void;
  send(message: OutboundMessage): Promise<void>;
  /** Optional: show a "typing…" indicator in the channel while the agent processes. */
  sendTyping?(node_id: string): Promise<void>;
  isHealthy(): Promise<boolean>;
  destroy(): Promise<void>;
}

export interface MediaAttachment {
  /** The kind of media to send. */
  type:       'photo' | 'document' | 'audio' | 'video' | 'voice' | 'animation';
  /** Publicly reachable URL or a Telegram file_id. */
  url:        string;
  caption?:   string;
  filename?:  string;
}

export interface OutboundMessage {
  node_id:      string;
  text?:        string;
  markdown?:    boolean;
  attachments?: MediaAttachment[];
}

export interface ChannelConfig {
  enabled:  boolean;
  [key: string]: unknown;
}
