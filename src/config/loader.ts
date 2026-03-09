import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import type { AgentConfig } from '../agents/types.js';

export const AURA_DIR = path.join(os.homedir(), '.aura');
export const SKILLS_DIR = path.join(AURA_DIR, 'skills');
export const MEMORY_DIR    = path.join(AURA_DIR, 'memory');
export const TOKENS_DIR    = path.join(AURA_DIR, 'tokens');
export const WORKSPACE_DIR = path.join(AURA_DIR, 'workspace');

export interface GatewayConfig {
  agent: {
    name:    string;
    persona: string;
  };
  llm: {
    default: string;
    routing: Record<string, string>;
    providers: Record<string, { api_key?: string; base_url?: string; models: string[] }>;
  };
  channels: Record<string, { enabled: boolean; [key: string]: unknown }>;
  voice: {
    tts: { provider: string; api_key?: string; voice_id: string };
    stt: { provider: string; api_key?: string };
  };
  canvas:    { enabled: boolean; port: number };
  scheduler: { heartbeat_interval_min: number; reminder_check_sec: number; nightly_summary_time: string };
  security:  { bind_address: string; anp_port: number; rest_port: number };
}

export interface NodesConfig {
  nodes: Array<{ id: string; token: string; caps: string[]; meta?: Record<string, unknown> }>;
}

function interpolateEnv(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(interpolateEnv);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v)])
    );
  }
  return obj;
}

function loadYaml<T>(filePath: string, defaultVal: T): T {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    const raw = fs.readFileSync(filePath, 'utf8');
    return interpolateEnv(yaml.load(raw)) as T;
  } catch (err) {
    console.error(`[Config] Failed to load ${filePath}:`, err);
    return defaultVal;
  }
}

export function loadConfig(): GatewayConfig {
  const configPath = path.join(AURA_DIR, 'config.yaml');
  const defaults: GatewayConfig = {
    agent: { name: 'AURA', persona: 'You are AURA, a personal AI agent.' },
    llm: {
      default: 'claude-haiku-4-5',
      routing: { simple: 'claude-haiku-4-5', complex: 'claude-sonnet-4-6', vision: 'claude-sonnet-4-6', local_vision: 'ollama/llava', creative: 'claude-opus-4', offline: 'ollama/llama3.2:3b', audio: 'qwen-omni-turbo', video: 'qwen-omni-turbo' },
      providers: {
        claude:      { api_key: process.env.ANTHROPIC_API_KEY,  models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4'] },
        openai:      { api_key: process.env.OPENAI_API_KEY,    models: ['gpt-4o', 'gpt-4o-mini'] },
        ollama:      { base_url: 'http://localhost:11434',      models: ['llama3.2:3b', 'llava', 'moondream'] },
        gemini:      { api_key: process.env.GOOGLE_API_KEY,    models: ['gemini-1.5-pro', 'gemini-1.5-flash'] },
        mistral:     { api_key: process.env.MISTRAL_API_KEY,   models: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-7b'] },
        openrouter:  { api_key: process.env.OPENROUTER_API_KEY, models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-pro-1.5'] },
        qwen:        { api_key: process.env.DASHSCOPE_API_KEY, base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-flash', 'qwq-plus', 'qwen-omni-turbo', 'qwen3-omni-flash'] },
      },
    },
    channels: {
      telegram: { enabled: false },
      whatsapp: { enabled: false },
      signal:   { enabled: false },
      slack:    { enabled: false },
      discord:  { enabled: false },
      google_chat: { enabled: false },
      teams:    { enabled: false },
      webchat:  { enabled: true, port: 3000 },
    },
    voice: {
      tts: { provider: 'elevenlabs', api_key: process.env.ELEVENLABS_API_KEY, voice_id: '21m00Tcm4TlvDq8ikWAM' },
      stt: { provider: 'whisper_api', api_key: process.env.OPENAI_API_KEY },
    },
    canvas:    { enabled: true, port: 3001 },
    scheduler: { heartbeat_interval_min: 30, reminder_check_sec: 60, nightly_summary_time: '23:30' },
    security:  { bind_address: '127.0.0.1', anp_port: 8765, rest_port: 3002 },
  };
  return { ...defaults, ...loadYaml<Partial<GatewayConfig>>(configPath, {}) } as GatewayConfig;
}

export function loadNodes(): NodesConfig {
  const nodesPath = path.join(AURA_DIR, 'nodes.yaml');
  return loadYaml<NodesConfig>(nodesPath, { nodes: [] });
}

export function loadAgents(): AgentConfig[] {
  const agentsPath = path.join(AURA_DIR, 'agents.yaml');
  const data = loadYaml<{ agents: AgentConfig[] }>(agentsPath, { agents: [] });
  return data.agents ?? [];
}

export function ensureAuraDirs(): void {
  for (const dir of [AURA_DIR, SKILLS_DIR, MEMORY_DIR, TOKENS_DIR, path.join(MEMORY_DIR, 'personal'), path.join(MEMORY_DIR, 'dev'), path.join(MEMORY_DIR, 'social')]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
