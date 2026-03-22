import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { AgentConfig } from '../agents/types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('Config');

// ── Zod schema — validates config.yaml at startup ────────────────────────────
// Note: Zod v4 requires .default() values to match the full output type.
// We use optional() + transform to allow missing top-level sections.
const ProviderSchema = z.object({
  api_key:  z.string().optional(),
  base_url: z.string().optional(),
  models:   z.array(z.string()).default(() => []),
});

const AgentSectionSchema = z.object({
  name:    z.string().min(1).default('AURA'),
  persona: z.string().min(1).default('You are AURA, a personal AI agent.'),
});

const LlmSectionSchema = z.object({
  default:   z.string().min(1).default('claude-haiku-4-5'),
  routing:   z.record(z.string(), z.string()).default({}),
  providers: z.record(z.string(), ProviderSchema).default({}),
});

const ChannelEntrySchema = z.object({ enabled: z.boolean().default(false) }).catchall(z.unknown());

const TtsSectionSchema = z.object({
  provider: z.string().default('elevenlabs'),
  api_key:  z.string().optional(),
  voice_id: z.string().default('21m00Tcm4TlvDq8ikWAM'),
});

const SttSectionSchema = z.object({
  provider: z.string().default('whisper_api'),
  api_key:  z.string().optional(),
});

const VoiceSectionSchema = z.object({
  tts: TtsSectionSchema.default({ provider: 'elevenlabs', voice_id: '21m00Tcm4TlvDq8ikWAM' }),
  stt: SttSectionSchema.default({ provider: 'whisper_api' }),
});

const CanvasSectionSchema = z.object({
  enabled: z.boolean().default(true),
  port:    z.number().int().min(1).max(65535).default(3001),
});

const SchedulerSectionSchema = z.object({
  heartbeat_interval_min: z.number().int().min(1).default(30),
  reminder_check_sec:     z.number().int().min(1).default(60),
  nightly_summary_time:   z.string().default('23:30'),
});

const SecuritySectionSchema = z.object({
  bind_address: z.string().default('127.0.0.1'),
  anp_port:     z.number().int().min(1).max(65535).default(8765),
  rest_port:    z.number().int().min(1).max(65535).default(3002),
});

const GatewayConfigSchema = z.object({
  agent:      AgentSectionSchema.optional().transform(v => v ?? AgentSectionSchema.parse({})),
  llm:        LlmSectionSchema.optional().transform(v => v ?? LlmSectionSchema.parse({})),
  channels:   z.record(z.string(), ChannelEntrySchema).optional().transform(v => v ?? {}),
  voice:      VoiceSectionSchema.optional().transform(v => v ?? VoiceSectionSchema.parse({})),
  canvas:     CanvasSectionSchema.optional().transform(v => v ?? CanvasSectionSchema.parse({})),
  scheduler:  SchedulerSectionSchema.optional().transform(v => v ?? SchedulerSectionSchema.parse({})),
  security:   SecuritySectionSchema.optional().transform(v => v ?? SecuritySectionSchema.parse({})),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const AURA_DIR = path.join(os.homedir(), '.aura');
export const SKILLS_DIR = path.join(AURA_DIR, 'skills');
export const MEMORY_DIR    = path.join(AURA_DIR, 'memory');
export const TOKENS_DIR    = path.join(AURA_DIR, 'tokens');
export const WORKSPACE_DIR = path.join(AURA_DIR, 'workspace');

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
    logger.error(`Failed to load ${filePath}`, { error: String(err) });
    return defaultVal;
  }
}

export function loadConfig(): GatewayConfig {
  const configPath = path.join(AURA_DIR, 'config.yaml');

  // Load raw YAML (empty object if file doesn't exist)
  const raw = loadYaml<Record<string, unknown>>(configPath, {});

  // Inject env-sourced provider keys so they're always available even if
  // the user doesn't explicitly list them in config.yaml
  const rawWithEnv = {
    ...raw,
    llm: {
      routing: {
        simple: 'claude-haiku-4-5', complex: 'claude-sonnet-4-6',
        vision: 'claude-sonnet-4-6', local_vision: 'ollama/llava',
        creative: 'claude-opus-4', offline: 'ollama/llama3.2:3b',
        audio: 'qwen-omni-turbo', video: 'qwen-omni-turbo',
      },
      providers: {
        claude:     { api_key: process.env.ANTHROPIC_API_KEY,   models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4'] },
        openai:     { api_key: process.env.OPENAI_API_KEY,      models: ['gpt-4o', 'gpt-4o-mini'] },
        ollama:     { base_url: 'http://localhost:11434',        models: ['llama3.2:3b', 'llava', 'moondream'] },
        gemini:     { api_key: process.env.GOOGLE_API_KEY,      models: ['gemini-1.5-pro', 'gemini-1.5-flash'] },
        mistral:    { api_key: process.env.MISTRAL_API_KEY,     models: ['mistral-large-latest', 'mistral-small-latest'] },
        openrouter: { api_key: process.env.OPENROUTER_API_KEY,  models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o'] },
        qwen:       { api_key: process.env.DASHSCOPE_API_KEY,   base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-flash', 'qwq-plus', 'qwen-omni-turbo'] },
      },
      ...(raw['llm'] as Record<string, unknown> | undefined ?? {}),
    },
    channels: {
      webchat: { enabled: true, port: 3000 },
      ...(raw['channels'] as Record<string, unknown> | undefined ?? {}),
    },
    voice: {
      tts: { api_key: process.env.ELEVENLABS_API_KEY },
      stt: { api_key: process.env.OPENAI_API_KEY },
      ...(raw['voice'] as Record<string, unknown> | undefined ?? {}),
    },
  };

  // Validate and apply defaults via Zod — fails fast with a clear message
  const result = GatewayConfigSchema.safeParse(rawWithEnv);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    logger.error(`Invalid config.yaml — fix these issues and restart:\n${issues}`);
    process.exit(1);
  }

  return result.data;
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
