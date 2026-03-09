function getConfig() {
  const url = process.env['HA_URL'];
  const token = process.env['HA_TOKEN'];
  if (!url || !token) throw new Error('HA_URL and HA_TOKEN environment variables required');
  return { url: url.replace(/\/$/, ''), token };
}

export async function ha_get_state(args: { entity_id: string }, _ctx: unknown): Promise<unknown> {
  const { url, token } = getConfig();
  const res = await fetch(`${url}/api/states/${args.entity_id}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`HA error ${res.status}: ${await res.text()}`);
  const data = await res.json() as Record<string, unknown>;
  return { state: data['state'], attributes: data['attributes'] };
}

export async function ha_call_service(
  args: { domain: string; service: string; data: Record<string, unknown> },
  _ctx: unknown
): Promise<unknown> {
  const { url, token } = getConfig();
  const res = await fetch(`${url}/api/services/${args.domain}/${args.service}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.data),
  });
  if (!res.ok) throw new Error(`HA error ${res.status}: ${await res.text()}`);
  return { success: true };
}

export async function ha_list_entities(args: { domain?: string }, _ctx: unknown): Promise<unknown> {
  const { url, token } = getConfig();
  const res = await fetch(`${url}/api/states`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`HA error ${res.status}: ${await res.text()}`);
  const states = await res.json() as Array<Record<string, unknown>>;
  const filtered = args.domain
    ? states.filter(s => String(s['entity_id']).startsWith(args.domain + '.'))
    : states;
  return filtered.map(s => ({
    entity_id: s['entity_id'],
    state:     s['state'],
    name:      (s['attributes'] as Record<string, unknown>)?.['friendly_name'] ?? s['entity_id'],
  }));
}
