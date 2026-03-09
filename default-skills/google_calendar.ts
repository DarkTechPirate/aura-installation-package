import fs from 'fs';
import os from 'os';
import path from 'path';

const CREDS_PATH = process.env['GOOGLE_OAUTH_CREDENTIALS'] ?? path.join(os.homedir(), '.aura', 'tokens', 'google.json');

function getAuth() {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(`Google OAuth credentials not found at ${CREDS_PATH}. Run the OAuth flow first.`);
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')) as { access_token: string; refresh_token: string };
}

async function calendarFetch(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const creds = getAuth();
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Google Calendar error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function calendar_list_events(args: { days?: number; calendar_id?: string }, _ctx: unknown): Promise<unknown> {
  try {
    const calId = encodeURIComponent(args.calendar_id ?? 'primary');
    const days = args.days ?? 7;
    const now = new Date();
    const end = new Date(now.getTime() + days * 86400000);
    const data = await calendarFetch(
      `/calendars/${calId}/events?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}&orderBy=startTime&singleEvents=true`
    ) as Record<string, unknown>;
    return (data['items'] as Array<Record<string, unknown>>) ?? [];
  } catch (e) { return { error: String(e) }; }
}

export async function calendar_create_event(
  args: { title: string; start_iso: string; end_iso: string; description?: string; location?: string },
  _ctx: unknown
): Promise<unknown> {
  try {
    const body = {
      summary: args.title,
      start: { dateTime: args.start_iso },
      end:   { dateTime: args.end_iso },
      ...(args.description ? { description: args.description } : {}),
      ...(args.location    ? { location: args.location } : {}),
    };
    const data = await calendarFetch('/calendars/primary/events', 'POST', body) as Record<string, unknown>;
    return data['htmlLink'];
  } catch (e) { return { error: String(e) }; }
}

export async function calendar_update_event(args: { event_id: string; updates: Record<string, unknown> }, _ctx: unknown): Promise<unknown> {
  try {
    await calendarFetch(`/calendars/primary/events/${args.event_id}`, 'PATCH', args.updates);
    return { updated: true };
  } catch (e) { return { error: String(e) }; }
}

export async function calendar_delete_event(args: { event_id: string }, _ctx: unknown): Promise<unknown> {
  try {
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${args.event_id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getAuth().access_token}` },
    });
    return { deleted: true };
  } catch (e) { return { error: String(e) }; }
}
