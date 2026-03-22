import type { IncomingMessage, ServerResponse } from 'http';
import type { LLMRouter } from './router.js';
import type { LLMMessage, ToolDefinition } from './types.js';
import type { AgentConfig } from '../agents/types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('AnthropicProxy');

/**
 * Anthropic-compatible API proxy.
 *
 * AURA acts as the LLM backend for Claude Code. When a `claude -p` subprocess
 * is spawned with ANTHROPIC_BASE_URL pointing here, every /v1/messages call
 * is intercepted, AURA's agent persona is injected into the system prompt,
 * and AURA's own LLM router handles the actual generation.
 *
 * Claude Code's ANTHROPIC_API_KEY is set to a dummy value — the proxy ignores
 * it and uses AURA's already-configured API key.
 */
export class AnthropicProxy {
  constructor(
    private llm:    LLMRouter,
    private agents: AgentConfig[],
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readBody(req);
      const claudeReq = JSON.parse(body) as AnthropicRequest;

      // Build AURA-injected system prompt
      const agent      = this.agents[0];
      const auraPrefix = agent
        ? `You are ${agent.name} — a personal AI agent — currently operating as Claude Code to complete a coding task on behalf of your user. You were launched programmatically by ${agent.name}. Maintain ${agent.name}'s personality and values throughout.\n\n${agent.persona}`
        : 'You are AURA, a personal AI agent, currently operating as Claude Code to complete a coding task.';

      const originalSystem = typeof claudeReq.system === 'string'
        ? claudeReq.system
        : Array.isArray(claudeReq.system)
          ? claudeReq.system.map((b: { text?: string }) => b.text ?? '').join('\n')
          : '';

      const system = originalSystem
        ? `${auraPrefix}\n\n---\n${originalSystem}`
        : auraPrefix;

      // Convert Anthropic messages → AURA LLMMessage format
      const messages: LLMMessage[] = convertMessages(claudeReq.messages ?? []);

      // Convert Anthropic tool definitions → AURA ToolDefinition format
      const toolDefs: ToolDefinition[] = (claudeReq.tools ?? []).map((t: AnthropicTool) => ({
        name:        t.name,
        description: t.description ?? '',
        parameters:  t.input_schema ?? { type: 'object', properties: {} },
      }));

      // Use the agent's configured tier (respects user's model preference).
      // Enforce a minimum of 2048 max_tokens — Claude Code often sends low values
      // but the injected system prompt needs headroom for the model to respond.
      const agentTier = this.agents[0]?.llm_tier ?? 'simple';
      const response = await this.llm.complete(agentTier, {
        system,
        messages,
        tools:      toolDefs.length > 0 ? toolDefs : undefined,
        max_tokens: Math.max(claudeReq.max_tokens ?? 4096, 2048),
      }, 'agent', `proxy-${Date.now()}`);

      logger.info(`Proxy request handled — ${response.usage.input_tokens}in/${response.usage.output_tokens}out`);

      // Build Anthropic-format content blocks
      const content: AnthropicContentBlock[] = [];
      if (response.text) {
        content.push({ type: 'text', text: response.text });
      }
      for (const tc of response.tool_calls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      if (content.length === 0) {
        content.push({ type: 'text', text: '' });
      }

      const stopReason = (response.tool_calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn';

      const isStream = claudeReq.stream === true;
      if (isStream) {
        await sendSSE(res, content, response.usage, claudeReq.model ?? 'claude-sonnet-4-6', stopReason);
      } else {
        const responseBody = JSON.stringify({
          id:           `msg_aura_${Date.now()}`,
          type:         'message',
          role:         'assistant',
          content,
          model:        claudeReq.model ?? 'claude-sonnet-4-6',
          stop_reason:  stopReason,
          stop_sequence: null,
          usage: {
            input_tokens:  response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      }
    } catch (err) {
      logger.error('Proxy error', { error: String(err) });
      const errBody = JSON.stringify({
        type:  'error',
        error: { type: 'api_error', message: String(err) },
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(errBody);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function convertMessages(anthropicMsgs: AnthropicMessage[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const msg of anthropicMsgs) {
    const role = msg.role as 'user' | 'assistant';
    if (typeof msg.content === 'string') {
      out.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    // Collect tool_use blocks from this assistant message so we can attach tool_calls
    const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
    const textParts: string[] = [];
    const toolResults: { tool_call_id: string; content: string }[] = [];

    for (const block of msg.content as AnthropicContentBlock[]) {
      if (block.type === 'text') {
        textParts.push(block.text ?? '');
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id:   block.id ?? `tc_${Date.now()}`,
          name: block.name ?? '',
          args: (block.input ?? {}) as Record<string, unknown>,
        });
      } else if (block.type === 'tool_result') {
        const resultContent = Array.isArray(block.content)
          ? (block.content as { text?: string }[]).map(c => c.text ?? '').join('\n')
          : typeof block.content === 'string'
            ? block.content
            : '';
        toolResults.push({
          tool_call_id: block.tool_use_id ?? '',
          content:      resultContent,
        });
      }
    }

    // tool_result blocks → emit as 'tool' role messages (one per result)
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        out.push({ role: 'tool', content: tr.content, tool_call_id: tr.tool_call_id });
      }
      continue;
    }

    // assistant with tool_use blocks
    if (toolCalls.length > 0) {
      out.push({ role: 'assistant', content: textParts.join(''), tool_calls: toolCalls });
      continue;
    }

    // plain text
    out.push({ role, content: textParts.join('') });
  }
  return out;
}

async function sendSSE(
  res:        ServerResponse,
  content:    AnthropicContentBlock[],
  usage:      { input_tokens: number; output_tokens: number },
  model:      string,
  stopReason: string,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });

  const msgId = `msg_aura_${Date.now()}`;

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant',
      content: [], model, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
    },
  });

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    send('content_block_start', { type: 'content_block_start', index: i, content_block: block });

    if (block.type === 'text' && block.text) {
      // Emit text in ~100-char chunks so Claude Code sees a progressive stream
      const chunks = chunkString(block.text, 100);
      for (const chunk of chunks) {
        send('content_block_delta', {
          type: 'content_block_delta', index: i,
          delta: { type: 'text_delta', text: chunk },
        });
      }
    }

    send('content_block_stop', { type: 'content_block_stop', index: i });
  }

  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });

  send('message_stop', { type: 'message_stop' });

  res.end();
}

function chunkString(str: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks.length > 0 ? chunks : [''];
}

// ── Anthropic API types (subset) ──────────────────────────────────────────────

interface AnthropicRequest {
  model?:     string;
  max_tokens?: number;
  system?:    string | { type: string; text?: string }[];
  messages?:  AnthropicMessage[];
  tools?:     AnthropicTool[];
  stream?:    boolean;
}

interface AnthropicMessage {
  role:    string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type:         string;
  text?:        string;
  id?:          string;
  name?:        string;
  input?:       unknown;
  tool_use_id?: string;
  content?:     string | { text?: string }[];
}

interface AnthropicTool {
  name:         string;
  description?: string;
  input_schema?: Record<string, unknown>;
}
