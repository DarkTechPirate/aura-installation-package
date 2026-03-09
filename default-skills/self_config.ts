import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';

const AURA_DIR   = path.join(os.homedir(), '.aura');
const CONFIG_PATH  = path.join(AURA_DIR, 'config.yaml');
const AGENTS_PATH  = path.join(AURA_DIR, 'agents.yaml');

// Env keys that are considered sensitive — values never exposed
const SENSITIVE_PATTERNS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIALS', 'OAUTH'];

function isSensitive(key: string): boolean {
  return SENSITIVE_PATTERNS.some(p => key.toUpperCase().includes(p));
}

function loadYaml(filePath: string): unknown {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function saveYaml(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, yaml.dump(data, { lineWidth: 120 }), 'utf8');
}

// ── Tool implementations ───────────────────────────────────────────────────────

export async function config_read(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const cfg = loadYaml(CONFIG_PATH) as Record<string, unknown>;

  // Sanitise: replace API key / token values with "SET" or "NOT SET"
  const sanitise = (obj: unknown): unknown => {
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return obj.map(sanitise);
    if (obj && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
          if (isSensitive(k)) {
            return [k, typeof v === 'string' && v.length > 0 ? '<SET>' : '<NOT SET>'];
          }
          return [k, sanitise(v)];
        })
      );
    }
    return obj;
  };

  return sanitise(cfg);
}

export async function agents_read(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  return loadYaml(AGENTS_PATH);
}

export async function env_list(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const relevant = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ELEVENLABS_API_KEY',
    'TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'DISCORD_BOT_TOKEN',
    'SIGNAL_PHONE_NUMBER', 'NOTION_API_KEY', 'SPOTIFY_CLIENT_ID',
    'TWITTER_API_KEY', 'WHOOP_CLIENT_ID', 'HA_URL', 'HA_TOKEN',
    'SERPAPI_KEY', 'GOOGLE_OAUTH_CREDENTIALS', 'GOOGLE_CHAT_CREDENTIALS_PATH',
    'ALPACA_API_KEY', 'ALPACA_API_SECRET', 'ALPACA_PAPER',
    'OANDA_API_TOKEN', 'OANDA_ACCOUNT_ID', 'OANDA_PRACTICE',
    'ELEVENLABS_VOICE_ID',
  ];
  const result: Record<string, string> = {};
  for (const key of relevant) {
    result[key] = process.env[key] ? 'SET' : 'NOT SET';
  }
  return result;
}

export async function env_set(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const key   = String(args['key']   ?? '').trim().toUpperCase();
  const value = String(args['value'] ?? '');
  if (!key) throw new Error('key is required');
  if (key.includes('=') || key.includes('\n')) throw new Error('Invalid key name');

  // Write to .env file so it persists across restarts
  const envPath = path.join(process.cwd(), '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { /* new file */ }

  const lines = content.split('\n').filter(l => !l.startsWith(`${key}=`) && l !== '');
  lines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');

  // Apply live — no restart needed
  process.env[key] = value;

  return {
    set: true,
    key,
    value_preview: isSensitive(key) ? '<hidden>' : value.slice(0, 40),
    note: 'Live in process.env immediately. Also written to .env for persistence across restarts.',
  };
}

export async function skill_add(
  args: Record<string, unknown>,
  ctx: unknown
): Promise<unknown> {
  const skillName = String(args['skill_name'] ?? '').trim();
  if (!skillName) throw new Error('skill_name is required');

  // Resolve which agent to update — use ctx.agent_id (memory_ns) or explicit agent_id arg
  const agentId = String(args['agent_id'] ?? (ctx as Record<string, unknown>)?.['agent_id'] ?? 'personal');

  const raw = loadYaml(AGENTS_PATH) as { agents: Array<Record<string, unknown>> };
  const agents = raw['agents'] ?? [];

  // Match by id or memory_ns
  const agent = agents.find(a => a['id'] === agentId || a['memory_ns'] === agentId);
  if (!agent) throw new Error(`Agent '${agentId}' not found in agents.yaml`);

  const skills = (agent['skills'] as string[] | undefined) ?? [];
  if (skills.includes(skillName)) {
    return { updated: false, message: `Skill '${skillName}' is already assigned to agent '${agent['id']}'.` };
  }

  skills.push(skillName);
  agent['skills'] = skills;
  saveYaml(AGENTS_PATH, raw);

  return {
    updated: true,
    agent: agent['id'],
    skill: skillName,
    total_skills: skills.length,
    note: 'agents.yaml updated. The gateway reloads agents.yaml live — no restart needed.',
  };
}

export async function skill_remove(
  args: Record<string, unknown>,
  ctx: unknown
): Promise<unknown> {
  const skillName = String(args['skill_name'] ?? '').trim();
  if (!skillName) throw new Error('skill_name is required');

  const agentId = String(args['agent_id'] ?? (ctx as Record<string, unknown>)?.['agent_id'] ?? 'personal');

  const raw = loadYaml(AGENTS_PATH) as { agents: Array<Record<string, unknown>> };
  const agents = raw['agents'] ?? [];

  const agent = agents.find(a => a['id'] === agentId || a['memory_ns'] === agentId);
  if (!agent) throw new Error(`Agent '${agentId}' not found in agents.yaml`);

  const skills = (agent['skills'] as string[] | undefined) ?? [];
  const next = skills.filter(s => s !== skillName);

  if (next.length === skills.length) {
    return { updated: false, message: `Skill '${skillName}' was not assigned to agent '${agent['id']}'.` };
  }

  agent['skills'] = next;
  saveYaml(AGENTS_PATH, raw);

  return { updated: true, agent: agent['id'], skill: skillName, removed: true };
}

export async function allowed_ids_add(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const channel = String(args['channel'] ?? 'telegram');
  const chatId  = String(args['chat_id'] ?? '');
  if (!chatId) throw new Error('chat_id is required');

  const cfg = loadYaml(CONFIG_PATH) as Record<string, unknown>;
  const channels = cfg['channels'] as Record<string, unknown> | undefined;
  if (!channels?.[channel]) throw new Error(`Channel '${channel}' not found in config`);

  const ch = channels[channel] as Record<string, unknown>;
  const ids = ((ch['allowed_ids'] as (string | number)[] | undefined) ?? []).map(String);

  if (ids.includes(chatId)) return { updated: false, message: `${chatId} is already in the allowlist` };

  ids.push(chatId);
  ch['allowed_ids'] = ids.map(Number).filter(n => !isNaN(n));
  saveYaml(CONFIG_PATH, cfg);
  return { updated: true, message: `Added ${chatId} to ${channel} allowlist. Restart required to take effect.` };
}

export async function allowed_ids_remove(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const channel = String(args['channel'] ?? 'telegram');
  const chatId  = String(args['chat_id'] ?? '');
  if (!chatId) throw new Error('chat_id is required');

  const cfg = loadYaml(CONFIG_PATH) as Record<string, unknown>;
  const channels = cfg['channels'] as Record<string, unknown> | undefined;
  if (!channels?.[channel]) throw new Error(`Channel '${channel}' not found in config`);

  const ch = channels[channel] as Record<string, unknown>;
  const ids = ((ch['allowed_ids'] as (string | number)[] | undefined) ?? []).map(String);
  const next = ids.filter(id => id !== chatId);

  if (next.length === ids.length) return { updated: false, message: `${chatId} was not in the allowlist` };

  ch['allowed_ids'] = next.map(Number).filter(n => !isNaN(n));
  saveYaml(CONFIG_PATH, cfg);
  return { updated: true, message: `Removed ${chatId} from ${channel} allowlist. Restart required to take effect.` };
}

export async function switch_model(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const model = String(args['model'] ?? '').trim();
  const tier  = String(args['tier']  ?? 'all').trim();
  if (!model) throw new Error('model is required');

  const TIERS = ['simple', 'complex', 'creative', 'vision', 'offline'];

  const cfg = loadYaml(CONFIG_PATH) as Record<string, unknown>;
  const llm = (cfg['llm'] as Record<string, unknown> | undefined) ?? {};
  const routing = (llm['routing'] as Record<string, string> | undefined) ?? {};

  const prev: Record<string, string> = {};
  const tiersToUpdate = tier === 'all' ? TIERS : [tier];

  for (const t of tiersToUpdate) {
    prev[t] = routing[t] ?? (llm['default'] as string | undefined) ?? 'unknown';
    routing[t] = model;
  }

  llm['routing'] = routing;
  llm['default'] = model;
  cfg['llm'] = llm;
  saveYaml(CONFIG_PATH, cfg);

  return {
    updated: true,
    model,
    tiers_updated: tiersToUpdate,
    previous: prev,
    note: 'LLM config reloaded automatically — no restart needed.',
  };
}

export async function list_models(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const ENV_FILE = path.join(path.dirname(CONFIG_PATH), '..', 'gateway', '.env');
  // Check which API keys are available in process.env
  const available: string[] = [];
  const unavailable: string[] = [];

  const checks: Array<[string, string[]]> = [
    ['ANTHROPIC_API_KEY',  ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']],
    ['OPENAI_API_KEY',     ['gpt-4o', 'gpt-4o-mini']],
    ['GOOGLE_API_KEY',     ['gemini-1.5-pro', 'gemini-1.5-flash']],
    ['MISTRAL_API_KEY',    ['mistral-large-latest', 'mistral-small-latest']],
    ['OPENROUTER_API_KEY', ['openrouter/anthropic/claude-3.5-sonnet', 'openrouter/openai/gpt-4o']],
  ];

  for (const [envKey, models] of checks) {
    if (process.env[envKey]) {
      available.push(...models);
    } else {
      unavailable.push(...models.map(m => `${m} (needs ${envKey})`));
    }
  }

  // Ollama models (always local)
  available.push('ollama/kimi-k2.5:cloud');

  const cfg = loadYaml(CONFIG_PATH) as Record<string, unknown>;
  const llm = (cfg['llm'] as Record<string, unknown> | undefined) ?? {};
  const routing = (llm['routing'] as Record<string, string> | undefined) ?? {};

  return {
    current_routing: routing,
    current_default: llm['default'],
    available_models: available,
    unavailable_models: unavailable,
    usage: 'Call switch_model with model name and optional tier (simple/complex/creative/vision/offline/all)',
  };
}

const HEARTBEAT_MD = path.join(AURA_DIR, 'HEARTBEAT.md');

export async function heartbeat_read(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const content = fs.existsSync(HEARTBEAT_MD)
    ? fs.readFileSync(HEARTBEAT_MD, 'utf8')
    : '(HEARTBEAT.md does not exist yet)';
  return { content };
}

export async function heartbeat_write(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const content = String(args['content'] ?? '');
  if (!content.trim()) throw new Error('content cannot be empty');
  fs.writeFileSync(HEARTBEAT_MD, content, 'utf8');
  return { written: true, note: 'HEARTBEAT.md updated. Changes take effect on the next heartbeat run.' };
}

export async function list_voices(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const apiKey = process.env['ELEVENLABS_API_KEY'];
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set. Use env_set to save it first.');

  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) throw new Error(`ElevenLabs API error: ${res.status} ${res.statusText}`);

  const data = await res.json() as { voices: Array<Record<string, unknown>> };
  const currentVoiceId = process.env['ELEVENLABS_VOICE_ID'] ?? '(not set)';

  const voices = data.voices.map(v => ({
    voice_id:   v['voice_id'],
    name:       v['name'],
    category:   v['category'],
    gender:     (v['labels'] as Record<string, string> | undefined)?.['gender'] ?? 'unknown',
    accent:     (v['labels'] as Record<string, string> | undefined)?.['accent'] ?? '-',
    use_case:   (v['labels'] as Record<string, string> | undefined)?.['use case'] ?? '-',
    current:    v['voice_id'] === currentVoiceId,
  }));

  return {
    current_voice_id: currentVoiceId,
    voices,
    count: voices.length,
    tip: 'Call set_voice with a voice_id from this list to change the TTS voice.',
  };
}

export async function set_voice(
  args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const voiceId = String(args['voice_id'] ?? '').trim();
  if (!voiceId) throw new Error('voice_id is required');

  // Write to .env and apply live — same pattern as env_set
  const envPath = path.join(process.cwd(), '.env');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch { /* new file */ }

  const lines = content.split('\n').filter(l => !l.startsWith('ELEVENLABS_VOICE_ID=') && l !== '');
  lines.push(`ELEVENLABS_VOICE_ID=${voiceId}`);
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
  process.env['ELEVENLABS_VOICE_ID'] = voiceId;

  return {
    updated: true,
    voice_id: voiceId,
    note: 'Voice changed immediately. New TTS responses will use this voice. No restart needed.',
  };
}

export async function list_skills(
  _args: Record<string, unknown>,
  _ctx: unknown
): Promise<unknown> {
  const SKILLS_DIR = path.join(AURA_DIR, 'skills');
  if (!fs.existsSync(SKILLS_DIR)) return { skills: [] };
  const yamlFiles = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.yaml'));
  const skills = yamlFiles.map(f => {
    try {
      const data = yaml.load(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8')) as Record<string, unknown>;
      return { name: data['name'], enabled: data['enabled'] ?? true, description: data['description'] ?? '' };
    } catch {
      return { name: f.replace('.yaml', ''), enabled: false, description: '(parse error)' };
    }
  });
  return { skills, count: skills.length, skills_dir: SKILLS_DIR };
}
