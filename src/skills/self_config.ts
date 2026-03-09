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
  ];
  const result: Record<string, string> = {};
  for (const key of relevant) {
    result[key] = process.env[key] ? 'SET' : 'NOT SET';
  }
  return result;
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
