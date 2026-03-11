import type { GatewayConfig } from '../config/loader.js';
import type { LLMParams, LLMResponse } from './types.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { OllamaAdapter } from './adapters/ollama.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { MistralAdapter } from './adapters/mistral.js';
import { OpenRouterAdapter } from './adapters/openrouter.js';
import { QwenAdapter } from './adapters/qwen.js';
import type { LLMAdapter } from './types.js';

export type LLMPriority = 'user' | 'background';

interface QueuedRequest {
  priority:  LLMPriority;
  tier:      string;
  params:    LLMParams;
  resolve:   (r: LLMResponse) => void;
  reject:    (e: unknown) => void;
}

/**
 * Routes LLM requests to the correct adapter based on tier configuration.
 * Supports live config reload via reload() — no restart required.
 *
 * Priority queue: 'user' requests always run before 'background' (heartbeat/pulse).
 * Only one LLM call runs at a time — Ollama is single-threaded.
 */
export class LLMRouter {
  private config: GatewayConfig;
  private adapters  = new Map<string, LLMAdapter>();
  private queue:    QueuedRequest[] = [];
  private running   = false;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  /**
   * Hot-reload the LLM config. Clears the adapter cache so new model/tier
   * mappings take effect immediately on the next request.
   */
  reload(newConfig: GatewayConfig): void {
    const oldRouting  = JSON.stringify(this.config.llm.routing);
    const oldDefault  = this.config.llm.default;
    this.config = newConfig;
    this.adapters.clear(); // force re-creation with new provider settings
    console.log('[LLM] Config reloaded.');
    if (this.config.llm.default !== oldDefault) {
      console.log(`[LLM]   default: ${oldDefault} → ${this.config.llm.default}`);
    }
    const newRouting = JSON.stringify(this.config.llm.routing);
    if (newRouting !== oldRouting) {
      for (const [tier, model] of Object.entries(this.config.llm.routing)) {
        console.log(`[LLM]   ${tier}: ${model}`);
      }
    }
  }

  /**
   * Complete a prompt using the specified tier or model string.
   * @param tier     - LLM tier ('simple', 'complex', 'vision', 'creative', 'offline') or model string
   * @param params   - LLM parameters
   * @param priority - 'user' (default) runs before 'background' (heartbeat/pulse)
   */
  complete(tier: string, params: LLMParams, priority: LLMPriority = 'user'): Promise<LLMResponse> {
    return new Promise<LLMResponse>((resolve, reject) => {
      const req: QueuedRequest = { priority, tier, params, resolve, reject };

      if (priority === 'user') {
        // Insert before any background requests already waiting
        const insertAt = this.queue.findIndex(r => r.priority === 'background');
        if (insertAt === -1) {
          this.queue.push(req);
        } else {
          this.queue.splice(insertAt, 0, req);
        }
      } else {
        this.queue.push(req);
      }

      this.drain();
    });
  }

  private drain(): void {
    if (this.running || this.queue.length === 0) return;
    const req = this.queue.shift()!;
    this.running = true;

    const modelStr = this.config.llm.routing[req.tier] ?? this.config.llm.default;
    const adapter  = this.getAdapter(modelStr);

    if (req.priority === 'background' && this.queue.some(r => r.priority === 'user')) {
      // A user request arrived while we were about to start a background one — requeue
      this.queue.unshift(req);
      this.running = false;
      this.drain();
      return;
    }

    console.log(`[LLM] Running ${req.priority} request (queue: ${this.queue.length} waiting)`);

    adapter.complete(req.params).then(
      (result) => { req.resolve(result); this.running = false; this.drain(); },
      (err)    => { req.reject(err);    this.running = false; this.drain(); },
    );
  }

  private getAdapter(modelStr: string): LLMAdapter {
    if (this.adapters.has(modelStr)) {
      return this.adapters.get(modelStr)!;
    }

    const adapter = this.createAdapter(modelStr);
    this.adapters.set(modelStr, adapter);
    return adapter;
  }

  private createAdapter(modelStr: string): LLMAdapter {
    let provider: string;
    let model: string;

    if (modelStr.includes('/')) {
      // Use indexOf to preserve slashes in model names (e.g. nvidia/moonshotai/kimi-k2.5)
      const idx = modelStr.indexOf('/');
      provider = modelStr.slice(0, idx);
      model    = modelStr.slice(idx + 1);
    } else if (modelStr.startsWith('claude-')) {
      provider = 'claude';
      model = modelStr;
    } else if (modelStr.startsWith('gpt-')) {
      provider = 'openai';
      model = modelStr;
    } else if (modelStr.startsWith('gemini-')) {
      provider = 'gemini';
      model = modelStr;
    } else if (modelStr.startsWith('mistral-') || modelStr.startsWith('open-mistral') || modelStr.startsWith('open-mixtral')) {
      provider = 'mistral';
      model = modelStr;
    } else if (modelStr.startsWith('qwen-') || modelStr.startsWith('qwq-') || modelStr.startsWith('qvq-')) {
      provider = 'qwen';
      model = modelStr;
    } else {
      provider = 'claude';
      model = modelStr;
    }

    const providerCfg = this.config.llm.providers[provider];

    switch (provider) {
      case 'claude': {
        const apiKey = providerCfg?.api_key ?? process.env['ANTHROPIC_API_KEY'] ?? '';
        return new ClaudeAdapter(apiKey, model);
      }
      case 'openai': {
        const apiKey = providerCfg?.api_key ?? process.env['OPENAI_API_KEY'] ?? '';
        return new OpenAIAdapter(apiKey, model);
      }
      case 'ollama': {
        const baseUrl = providerCfg?.base_url ?? 'http://localhost:11434';
        return new OllamaAdapter(baseUrl, model);
      }
      case 'lm_studio': {
        const baseUrl = providerCfg?.base_url ?? 'http://localhost:1234';
        return new OllamaAdapter(baseUrl, model); // LM Studio is Ollama-compatible
      }
      case 'gemini': {
        const apiKey = providerCfg?.api_key ?? process.env['GOOGLE_API_KEY'] ?? '';
        return new GeminiAdapter(apiKey, model);
      }
      case 'mistral': {
        const apiKey = providerCfg?.api_key ?? process.env['MISTRAL_API_KEY'] ?? '';
        return new MistralAdapter(apiKey, model);
      }
      case 'openrouter': {
        const apiKey = providerCfg?.api_key ?? process.env['OPENROUTER_API_KEY'] ?? '';
        return new OpenRouterAdapter(apiKey, model);
      }
      case 'nvidia': {
        const apiKey = providerCfg?.api_key ?? process.env['NVIDIA_API_KEY'] ?? '';
        return new OpenAIAdapter(apiKey, model, 'https://integrate.api.nvidia.com/v1');
      }
      case 'qwen': {
        const apiKey = providerCfg?.api_key ?? process.env['DASHSCOPE_API_KEY'] ?? '';
        return new QwenAdapter(apiKey, model);
      }
      default:
        throw new Error(`Unknown LLM provider: ${provider}`);
    }
  }
}
