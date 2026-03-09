import type { LLMAdapter, LLMParams, LLMResponse, ToolCall } from '../types.js';

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

interface OllamaResponse {
  message: OllamaMessage;
  prompt_eval_count?: number;
  eval_count?: number;
  model: string;
}

export class OllamaAdapter implements LLMAdapter {
  private baseUrl: string;
  readonly provider = 'ollama';
  readonly model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  async complete(params: LLMParams): Promise<LLMResponse> {
    const messages = [
      { role: 'system', content: params.system },
      ...params.messages.map(m => {
        const msg: Record<string, unknown> = {
          role:    m.role === 'tool' ? 'tool' : m.role,
          content: m.content,
        };
        // Pass tool_call_id for tool result messages
        if (m.role === 'tool' && m.tool_call_id) {
          msg['tool_call_id'] = m.tool_call_id;
        }
        // Pass tool_calls on assistant messages so Ollama has proper context
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
          msg['tool_calls'] = m.tool_calls.map(tc => ({
            function: { name: tc.name, arguments: tc.args },
          }));
        }
        // Pass image for vision messages — Ollama uses images: [base64] on the message
        if (m.role === 'user' && m.image_b64) {
          msg['images'] = [m.image_b64];
        }
        return msg;
      }),
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const doFetch = async (b: Record<string, unknown>): Promise<Response> => {
      try {
        return await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(b),
        });
      } catch (err) {
        throw new Error(`Ollama not available: ${String(err)}`);
      }
    };

    let response = await doFetch(body);

    if (!response.ok) {
      const errText = await response.text();
      // Model doesn't support vision — strip images and retry once
      if (errText.includes('image_url is not supported') || errText.includes('does not support vision')) {
        console.warn('[Ollama] Model does not support vision — retrying without image');
        const bodyNoImg = { ...body, messages: (body.messages as Record<string, unknown>[]).map(m => { const { images: _, ...rest } = m as Record<string, unknown> & { images?: unknown }; return rest; }) };
        response = await doFetch(bodyNoImg);
        if (!response.ok) throw new Error(`Ollama error ${response.status}: ${await response.text()}`);
      } else {
        throw new Error(`Ollama error ${response.status}: ${errText}`);
      }
    }

    const data = await response.json() as OllamaResponse;
    const msg = data.message;

    let text = msg.content ?? '';
    const toolCalls: ToolCall[] = [];

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        // Ollama may return arguments as a JSON string or as an object
        const rawArgs = tc.function.arguments;
        let parsedArgs: Record<string, unknown>;
        if (typeof rawArgs === 'string') {
          try {
            parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
          } catch {
            parsedArgs = {};
          }
        } else {
          parsedArgs = rawArgs ?? {};
        }
        toolCalls.push({
          id:   crypto.randomUUID(),
          name: tc.function.name,
          args: parsedArgs,
        });
      }
      text = '';
    }

    return {
      text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens:  data.prompt_eval_count ?? 0,
        output_tokens: data.eval_count ?? 0,
      },
      model:    data.model,
      provider: this.provider,
    };
  }
}
