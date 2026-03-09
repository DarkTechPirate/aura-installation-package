export interface LLMAdapter {
  complete(params: LLMParams): Promise<LLMResponse>;
  readonly provider: string;
  readonly model:    string;
}

export interface LLMParams {
  system:      string;
  messages:    LLMMessage[];
  tools?:      ToolDefinition[];
  max_tokens?: number;
}

export interface LLMMessage {
  role:          'user' | 'assistant' | 'tool';
  content:       string;
  image_b64?:    string;      // base64-encoded image for vision messages (user role only)
  audio_url?:    string;      // URL to audio file for Qwen-Omni audio input (user role only)
  video_url?:    string;      // URL to video file for Qwen-Omni video input (user role only)
  tool_call_id?: string;
  tool_calls?:   ToolCall[];  // included in assistant messages that triggered tool calls
}

export interface LLMResponse {
  text:        string;
  tool_calls?: ToolCall[];
  usage:       { input_tokens: number; output_tokens: number };
  model:       string;
  provider:    string;
}

export interface ToolCall {
  id:   string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolDefinition {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>;
}

export type LLMTier = 'simple' | 'complex' | 'vision' | 'creative' | 'offline' | 'audio' | 'video';
