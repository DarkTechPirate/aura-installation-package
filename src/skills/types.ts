import type { CanvasBlock } from '../canvas/types.js';
import type { MediaAttachment } from '../channels/interface.js';

export interface SkillDefinition {
  name:         string;
  version:      string;
  description:  string;
  executor:     string;
  enabled:      boolean;
  source:       'human' | 'self_written';
  requires_env: string[];
  tools:        SkillTool[];
}

export interface SkillTool {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>;
}

export interface SkillContext {
  node_id:    string;
  session_id: string;
  agent_id:   string;
  anp:        { sendCommand: (node_id: string, cmd: string, payload: unknown) => void };
  memory:     { search: (q: string) => Promise<string[]> };
  channel:    { send: (node_id: string, text?: string, attachments?: MediaAttachment[]) => Promise<void> };
  canvas:     { append: (block: CanvasBlock) => void; clear: () => void };
}
