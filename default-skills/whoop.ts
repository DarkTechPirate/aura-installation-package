import fs from 'fs';
import os from 'os';
import path from 'path';

const TOKEN_PATH = path.join(os.homedir(), '.aura', 'tokens', 'whoop.json');

function getEnv() {
  const clientId = process.env['WHOOP_CLIENT_ID'];
  const clientSecret = process.env['WHOOP_CLIENT_SECRET'];
  if (!clientId || !clientSecret) {
    throw new Error('WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET required. Visit developer.whoop.com to get credentials.');
  }
  return { clientId, clientSecret };
}

async function getToken(): Promise<string> {
  if (fs.existsSync(TOKEN_PATH)) {
    const t = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) as { access_token: string; expires_at: number };
    if (t.expires_at > Date.now() + 60000) return t.access_token;
  }
  throw new Error('WHOOP: OAuth token not set up. Run the OAuth flow to authenticate.');
}

async function whoopFetch(endpoint: string): Promise<Record<string, unknown>> {
  const token = await getToken();
  const res = await fetch(`https://api.prod.whoop.com/developer/v1${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`WHOOP API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

export async function whoop_recovery(args: { date?: string }, _ctx: unknown): Promise<unknown> {
  try {
    getEnv();
    const data = await whoopFetch('/recovery?limit=1');
    const records = (data['records'] as Array<Record<string, unknown>>) ?? [];
    const r = records[0]?.['score'] as Record<string, unknown> | undefined;
    return r ? { score: r['recovery_score'], hrv: r['hrv_rmssd_milli'], resting_hr: r['resting_heart_rate'], sleep_quality: r['sleep_performance_percentage'] } : { error: 'No recovery data' };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function whoop_sleep(args: { date?: string }, _ctx: unknown): Promise<unknown> {
  try {
    getEnv();
    const data = await whoopFetch('/activity/sleep?limit=1');
    const records = (data['records'] as Array<Record<string, unknown>>) ?? [];
    const r = records[0] as Record<string, unknown> | undefined;
    const score = r?.['score'] as Record<string, unknown> | undefined;
    return r ? { performance: score?.['sleep_performance_percentage'], duration_hours: Number(r['time_in_bed_milli'] ?? 0) / 3600000, disturbances: score?.['disturbances'] } : { error: 'No sleep data' };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function whoop_strain(args: { date?: string }, _ctx: unknown): Promise<unknown> {
  try {
    getEnv();
    const data = await whoopFetch('/cycle?limit=1');
    const records = (data['records'] as Array<Record<string, unknown>>) ?? [];
    const r = records[0] as Record<string, unknown> | undefined;
    const score = r?.['score'] as Record<string, unknown> | undefined;
    return r ? { score: score?.['strain'], avg_hr: score?.['average_heart_rate'], max_hr: score?.['max_heart_rate'], calories: score?.['kilojoule'] } : { error: 'No strain data' };
  } catch (e) {
    return { error: String(e) };
  }
}
