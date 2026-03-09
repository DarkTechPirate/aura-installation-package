import fs from 'fs';
import os from 'os';
import path from 'path';

const TOKEN_PATH = path.join(os.homedir(), '.aura', 'tokens', 'spotify.json');

function getEnv() {
  const clientId = process.env['SPOTIFY_CLIENT_ID'];
  const clientSecret = process.env['SPOTIFY_CLIENT_SECRET'];
  if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET required');
  return { clientId, clientSecret };
}

async function getToken(): Promise<string> {
  if (fs.existsSync(TOKEN_PATH)) {
    const t = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) as { access_token: string; expires_at: number };
    if (t.expires_at > Date.now() + 60000) return t.access_token;
  }
  throw new Error('Spotify OAuth not set up. Run the OAuth PKCE flow to authenticate.');
}

async function spotifyFetch(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const token = await getToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return {};
  if (!res.ok) throw new Error(`Spotify error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function spotify_play(args: { uri?: string }, _ctx: unknown): Promise<unknown> {
  try {
    getEnv();
    const body = args.uri ? { uris: [args.uri] } : undefined;
    await spotifyFetch('/me/player/play', 'PUT', body);
    return { playing: true };
  } catch (e) { return { error: String(e) }; }
}

export async function spotify_pause(_args: unknown, _ctx: unknown): Promise<unknown> {
  try { getEnv(); await spotifyFetch('/me/player/pause', 'PUT'); return { paused: true }; }
  catch (e) { return { error: String(e) }; }
}

export async function spotify_next(_args: unknown, _ctx: unknown): Promise<unknown> {
  try { getEnv(); await spotifyFetch('/me/player/next', 'POST'); return { skipped: true }; }
  catch (e) { return { error: String(e) }; }
}

export async function spotify_search(args: { query: string; type?: string }, _ctx: unknown): Promise<unknown> {
  try {
    getEnv();
    const type = args.type ?? 'track';
    const data = await spotifyFetch(`/search?q=${encodeURIComponent(args.query)}&type=${type}&limit=5`) as Record<string, unknown>;
    const key = type + 's';
    return (data[key] as Record<string, unknown>)?.['items'] ?? [];
  } catch (e) { return { error: String(e) }; }
}

export async function spotify_current(_args: unknown, _ctx: unknown): Promise<unknown> {
  try {
    getEnv();
    const data = await spotifyFetch('/me/player/currently-playing') as Record<string, unknown>;
    if (!data || !data['item']) return { playing: false };
    const item = data['item'] as Record<string, unknown>;
    const artists = (item['artists'] as Array<Record<string, unknown>>) ?? [];
    return {
      track: item['name'], artist: artists.map(a => a['name']).join(', '),
      album: (item['album'] as Record<string, unknown>)?.['name'],
      progress_ms: data['progress_ms'], is_playing: data['is_playing'],
    };
  } catch (e) { return { error: String(e) }; }
}

export async function spotify_volume(args: { percent: number }, _ctx: unknown): Promise<unknown> {
  try { getEnv(); await spotifyFetch(`/me/player/volume?volume_percent=${args.percent}`, 'PUT'); return { volume: args.percent }; }
  catch (e) { return { error: String(e) }; }
}
