import { execSync } from 'child_process';

const isMac = process.platform === 'darwin';
const NA = 'Not available on this OS';

function jxa(script: string): unknown {
  if (!isMac) return NA;
  const result = execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "\\'")}'`, { encoding: 'utf8' });
  return result.trim();
}

export async function notes_list(args: { search?: string }, _ctx: unknown): Promise<unknown> {
  if (!isMac) return [{ error: NA }];
  try {
    const filter = args.search ? `whose name contains "${args.search}"` : '';
    const script = `
      var app = Application('Notes');
      var notes = app.notes${filter ? ' ' + filter : ''}.slice(0, 20);
      return notes.map(n => ({ id: n.id(), title: n.name(), modified: n.modificationDate().toISOString() }));
    `;
    return JSON.parse(execSync(`osascript -l JavaScript -e '${script.replace(/'/g, "\\'")}'`, { encoding: 'utf8' }));
  } catch (e) { return { error: String(e) }; }
}

export async function notes_read(args: { note_id: string }, _ctx: unknown): Promise<unknown> {
  if (!isMac) return NA;
  try {
    return execSync(`osascript -l JavaScript -e 'Application("Notes").notes.byId("${args.note_id}").body()'`, { encoding: 'utf8' }).trim();
  } catch (e) { return { error: String(e) }; }
}

export async function notes_create(args: { title: string; body: string; folder?: string }, _ctx: unknown): Promise<unknown> {
  if (!isMac) return { error: NA };
  try {
    execSync(`osascript -l JavaScript -e 'Application("Notes").make({new:"note",withProperties:{name:"${args.title.replace(/"/g, '\\"')}",body:"${args.body.replace(/"/g, '\\"')}"}})'`, { encoding: 'utf8' });
    return { created: true };
  } catch (e) { return { error: String(e) }; }
}

export async function notes_append(args: { note_id: string; content: string }, _ctx: unknown): Promise<unknown> {
  if (!isMac) return { error: NA };
  return { error: 'notes_append: Use AppleScript to append. Feature stub.' };
}

export async function apple_reminders_list(args: { list?: string }, _ctx: unknown): Promise<unknown> {
  if (!isMac) return [{ error: NA }];
  return { error: 'apple_reminders_list: Use the reminders skill for cross-platform support.' };
}

export async function apple_reminders_create(args: { title: string; due_iso?: string; list?: string }, _ctx: unknown): Promise<unknown> {
  if (!isMac) return { error: NA };
  return { error: 'Use the reminders skill for cross-platform reminder creation.' };
}

export async function apple_reminders_complete(args: { reminder_id: string }, _ctx: unknown): Promise<unknown> {
  if (!isMac) return { error: NA };
  return { error: 'Use the reminders skill to manage reminders.' };
}
