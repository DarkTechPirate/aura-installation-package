import OpenAI from 'openai';
import type { LLMAdapter, LLMParams, LLMResponse, ToolCall } from '../types.js';

const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

export class QwenAdapter implements LLMAdapter {
  private client: OpenAI;
  readonly provider = 'qwen';
  readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey, baseURL: QWEN_BASE_URL });
    this.model = model;
  }

  private isOmni(): boolean {
    return this.model.includes('omni');
  }

  private isReasoning(): boolean {
    return this.model.startsWith('qwq') || this.model.includes('thinking');
  }

  private stripThinkBlocks(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
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

      if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          return {
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.tool_calls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          };
        }
        return { role: 'assistant', content: msg.content };
      }

      // user message — build multimodal content array if audio/video/image present
      if (msg.role === 'user' && (msg.audio_url || msg.video_url || msg.image_b64)) {
        const content: OpenAI.ChatCompletionContentPart[] = [];

        if (msg.audio_url) {
          content.push({ type: 'input_audio', input_audio: { url: msg.audio_url } } as unknown as OpenAI.ChatCompletionContentPart);
        }
        if (msg.video_url) {
          content.push({ type: 'video_url', video_url: { url: msg.video_url } } as unknown as OpenAI.ChatCompletionContentPart);
        }
        if (msg.image_b64) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${msg.image_b64}` },
          });
        }
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        return { role: 'user', content };
      }

      return { role: 'user', content: msg.content };
    });

    const tools: OpenAI.ChatCompletionTool[] | undefined = params.tools?.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const toolCalls: ToolCall[] = [];
    let text = '';

    if (this.isOmni()) {
      // Omni models REQUIRE stream: true
      const stream = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: params.max_tokens ?? 4096,
        messages: [{ role: 'system', content: params.system }, ...messages],
        stream: true,
        modalities: ['text'],
        ...(tools && tools.length > 0 ? { tools } : {}),
      } as OpenAI.ChatCompletionCreateParamsStreaming);

      let inputTokens = 0;
      let outputTokens = 0;
      const tcMap = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) text += delta.content;

        for (const tc of delta?.tool_calls ?? []) {
          if (!tcMap.has(tc.index)) {
            tcMap.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
          }
          const entry = tcMap.get(tc.index)!;
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }
      }

      for (const [, tc] of tcMap) {
        toolCalls.push({ id: tc.id, name: tc.name, args: JSON.parse(tc.args || '{}') as Record<string, unknown> });
      }

      return {
        text: this.isReasoning() ? this.stripThinkBlocks(text) : text,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        model: this.model,
        provider: this.provider,
      };
    }

    // Standard models (qwen-max, qwen-plus, qwq-plus, etc.) — non-streaming
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: params.max_tokens ?? 4096,
      messages: [{ role: 'system', content: params.system }, ...messages],
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    const choice = response.choices[0];
    text = choice?.message?.content ?? '';

    for (const tc of choice?.message?.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      });
    }

    return {
      text: this.isReasoning() ? this.stripThinkBlocks(text) : text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
      model: this.model,
      provider: this.provider,
    };
  }
}
