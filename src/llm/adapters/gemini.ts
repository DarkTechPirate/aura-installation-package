import { GoogleGenerativeAI, type FunctionDeclaration, type Part } from '@google/generative-ai';
import type { LLMAdapter, LLMParams, LLMResponse, ToolCall } from '../types.js';

export class GeminiAdapter implements LLMAdapter {
  private genAI: GoogleGenerativeAI;
  readonly provider = 'gemini';
  readonly model: string;

  constructor(apiKey: string, model: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async complete(params: LLMParams): Promise<LLMResponse> {
    const geminiModel = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: params.system,
    });

    // Convert tool definitions to FunctionDeclarations
    const tools = params.tools && params.tools.length > 0
      ? [{
          functionDeclarations: params.tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters as unknown as FunctionDeclaration['parameters'],
          } as FunctionDeclaration)),
        }]
      : undefined;

    // Build parts array for a message — handles text, image, audio, video
    const buildParts = (msg: (typeof params.messages)[0]) => {
      const parts: Part[] = [];
      if (msg.image_b64) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: msg.image_b64 } });
      }
      if (msg.audio_url) {
        // audio/video via fileData — URL must be a Google AI Files API URI or public gs:// URI
        parts.push({ fileData: { mimeType: 'audio/mp3', fileUri: msg.audio_url } });
      }
      if (msg.video_url) {
        parts.push({ fileData: { mimeType: 'video/mp4', fileUri: msg.video_url } });
      }
      if (msg.content) parts.push({ text: msg.content });
      return parts.length > 0 ? parts : [{ text: '' }];
    };

    // Build history from messages (all but last)
    const history = params.messages.slice(0, -1).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: buildParts(msg),
    }));

    const lastMsg = params.messages[params.messages.length - 1];
    const lastParts = lastMsg ? buildParts(lastMsg) : [{ text: '' }];

    const chat = geminiModel.startChat({
      history,
      ...(tools ? { tools } : {}),
    });

    const result = await chat.sendMessage(lastParts as never);
    const response = result.response;

    let text = '';
    const toolCalls: ToolCall[] = [];

    const candidate = response.candidates?.[0];
    if (candidate) {
      for (const part of candidate.content.parts) {
        if ('text' in part && part.text) {
          text += part.text;
        }
        if ('functionCall' in part && part.functionCall) {
          toolCalls.push({
            id:   crypto.randomUUID(),
            name: part.functionCall.name,
            args: part.functionCall.args as Record<string, unknown>,
          });
        }
      }
    }

    return {
      text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens:  response.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
      model:    this.model,
      provider: this.provider,
    };
  }
}
