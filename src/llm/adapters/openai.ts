import OpenAI from 'openai';
import type { LLMAdapter, LLMParams, LLMResponse, ToolCall } from '../types.js';

export class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI;
  readonly provider = 'openai';
  readonly model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = model;
  }

  async complete(params: LLMParams): Promise<LLMResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = params.messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.tool_call_id ?? '',
          content: msg.content,
        };
      }
      // image support — gpt-4o, gpt-4o-mini, gpt-4-turbo
      if (msg.role === 'user' && msg.image_b64) {
        return {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${msg.image_b64}` } },
            { type: 'text', text: msg.content },
          ],
        };
      }
      return { role: msg.role as 'user' | 'assistant', content: msg.content };
    });

    const tools: OpenAI.ChatCompletionTool[] | undefined = params.tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: params.max_tokens ?? 4096,
      messages: [
        { role: 'system', content: params.system },
        ...messages,
      ],
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    const choice = response.choices[0];
    const text = choice?.message?.content ?? '';
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? [])
      .filter(tc => tc.type === 'function')
      .map(tc => ({
        id:   tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));

    return {
      text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens:  response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
      model:    this.model,
      provider: this.provider,
    };
  }
}
