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

export type LLMPriority = 'user' | 'agent' | 'background';

// Max parallel LLM calls for agent sub-agents (cloud providers handle concurrency fine)
const AGENT_MAX_CONCURRENT = 4;

interface QueuedRequest {
  tier:    string;
  params:  LLMParams;
  resolve: (r: LLMResponse) => void;
  reject:  (e: unknown) => void;
}

interface SessionLane {
  queue:   QueuedRequest[];
  running: boolean;
}

/**
 * Routes LLM requests to the correct adapter based on tier configuration.
 * Supports live config reload via reload() — no restart required.
 *
 * Three independent lanes:
 *   user       — per-session serialization; multiple sessions run in parallel
 *   agent      — parallel pool (max AGENT_MAX_CONCURRENT); for spawn_team sub-agents
 *   background — single queue, sequential; heartbeat/pulse never blocks user lanes
 */
export class LLMRouter {
  private config:   GatewayConfig;
  private adapters  = new Map<string, LLMAdapter>();

  // Lane 1: per-session user calls (session_id → lane)
  private sessionLanes = new Map<string, SessionLane>();

  // Lane 2: agent sub-calls (semaphore pool)
  private agentActive = 0;
  private agentQueue: QueuedRequest[] = [];

  // Lane 3: background calls (single sequential queue)
  private bgQueue:   QueuedRequest[] = [];
  private bgRunning  = false;

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
   * @param tier      - LLM tier ('simple', 'complex', 'vision', etc.) or model string
   * @param params    - LLM parameters
   * @param priority  - 'user' (default) | 'agent' (parallel pool) | 'background' (heartbeat)
   * @param sessionId - Session identifier for per-session user lane serialization
   */
  complete(
    tier:      string,
    params:    LLMParams,
    priority:  LLMPriority = 'user',
    sessionId: string      = 'default',
  ): Promise<LLMResponse> {
    return new Promise<LLMResponse>((resolve, reject) => {
      const req: QueuedRequest = { tier, params, resolve, reject };

      if (priority === 'agent') {
        this.agentEnqueue(req);
      } else if (priority === 'background') {
        this.bgQueue.push(req);
        this.bgDrain();
      } else {
        // Lane 1: per-session — serialized within a session, parallel across sessions
        let lane = this.sessionLanes.get(sessionId);
        if (!lane) {
          lane = { queue: [], running: false };
          this.sessionLanes.set(sessionId, lane);
        }
        lane.queue.push(req);
        this.sessionDrain(sessionId, lane);
      }
    });
  }

  // ── Lane 1: per-session user calls ────────────────────────────────────────

  private sessionDrain(sid: string, lane: SessionLane): void {
    if (lane.running || lane.queue.length === 0) return;
    const req = lane.queue.shift()!;
    lane.running = true;

    const adapter = this.resolveAdapter(req.tier);
    console.log(`[LLM] [session:${sid}] Running (queue: ${lane.queue.length} waiting)`);

    adapter.complete(req.params).then(
      (result) => {
        req.resolve(result);
        lane.running = false;
        if (lane.queue.length === 0) {
          this.sessionLanes.delete(sid); // cleanup idle lanes
        } else {
          this.sessionDrain(sid, lane);
        }
      },
      (err) => {
        req.reject(err);
        lane.running = false;
        if (lane.queue.length === 0) {
          this.sessionLanes.delete(sid);
        } else {
          this.sessionDrain(sid, lane);
        }
      },
    );
  }

  // ── Lane 2: agent sub-calls (semaphore pool) ──────────────────────────────

  private agentEnqueue(req: QueuedRequest): void {
    if (this.agentActive < AGENT_MAX_CONCURRENT) {
      this.agentRun(req);
    } else {
      this.agentQueue.push(req);
    }
  }

  private agentRun(req: QueuedRequest): void {
    this.agentActive++;
    const adapter = this.resolveAdapter(req.tier);
    console.log(`[LLM] [agent] Running (active: ${this.agentActive}/${AGENT_MAX_CONCURRENT}, queued: ${this.agentQueue.length})`);

    adapter.complete(req.params).then(
      (result) => { req.resolve(result); this.agentActive--; this.agentDrain(); },
      (err)    => { req.reject(err);    this.agentActive--; this.agentDrain(); },
    );
  }

  private agentDrain(): void {
    if (this.agentQueue.length > 0 && this.agentActive < AGENT_MAX_CONCURRENT) {
      this.agentRun(this.agentQueue.shift()!);
    }
  }

  // ── Lane 3: background calls ───────────────────────────────────────────────

  private bgDrain(): void {
    if (this.bgRunning || this.bgQueue.length === 0) return;
    const req = this.bgQueue.shift()!;
    this.bgRunning = true;

    const adapter = this.resolveAdapter(req.tier);
    console.log(`[LLM] [background] Running (queue: ${this.bgQueue.length} waiting)`);

    adapter.complete(req.params).then(
      (result) => { req.resolve(result); this.bgRunning = false; this.bgDrain(); },
      (err)    => { req.reject(err);    this.bgRunning = false; this.bgDrain(); },
    );
  }

  // ── Adapter resolution ────────────────────────────────────────────────────

  private resolveAdapter(tier: string): LLMAdapter {
    const modelStr = this.config.llm.routing[tier] ?? this.config.llm.default;
    return this.getAdapter(modelStr);
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
