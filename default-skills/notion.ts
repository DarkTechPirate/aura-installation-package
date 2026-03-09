function getClient() {
  const apiKey = process.env['NOTION_API_KEY'];
  if (!apiKey) throw new Error('NOTION_API_KEY environment variable required');
  return apiKey;
}

async function notionFetch(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const apiKey = getClient();
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Notion API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function notion_search(args: { query: string }, _ctx: unknown): Promise<unknown> {
  try {
    const data = await notionFetch('/search', 'POST', { query: args.query }) as Record<string, unknown>;
    const results = (data['results'] as Array<Record<string, unknown>>) ?? [];
    return results.map(r => ({
      id:    r['id'],
      title: (r['properties'] as Record<string, unknown>)?.['Name'] ?? r['id'],
      url:   r['url'],
    }));
  } catch (e) { return { error: String(e) }; }
}

export async function notion_get_page(args: { page_id: string }, _ctx: unknown): Promise<unknown> {
  try {
    const data = await notionFetch(`/blocks/${args.page_id}/children`) as Record<string, unknown>;
    const blocks = (data['results'] as Array<Record<string, unknown>>) ?? [];
    const lines: string[] = [];
    for (const b of blocks) {
      const type = b['type'] as string;
      const content = (b[type] as Record<string, unknown>)?.['rich_text'] as Array<Record<string, unknown>> | undefined;
      if (content) lines.push(content.map(t => (t['plain_text'] as string) ?? '').join(''));
    }
    return lines.join('\n');
  } catch (e) { return { error: String(e) }; }
}

export async function notion_create_page(args: { parent_id: string; title: string; content: string }, _ctx: unknown): Promise<unknown> {
  try {
    const data = await notionFetch('/pages', 'POST', {
      parent: { page_id: args.parent_id },
      properties: { title: { title: [{ text: { content: args.title } }] } },
      children: [{ paragraph: { rich_text: [{ text: { content: args.content } }] } }],
    }) as Record<string, unknown>;
    return data['url'];
  } catch (e) { return { error: String(e) }; }
}

export async function notion_append_block(args: { page_id: string; content: string }, _ctx: unknown): Promise<unknown> {
  try {
    await notionFetch(`/blocks/${args.page_id}/children`, 'PATCH', {
      children: [{ paragraph: { rich_text: [{ text: { content: args.content } }] } }],
    });
    return { success: true };
  } catch (e) { return { error: String(e) }; }
}

export async function notion_query_database(args: { database_id: string; filter?: unknown }, _ctx: unknown): Promise<unknown> {
  try {
    const body: Record<string, unknown> = {};
    if (args.filter) body['filter'] = args.filter;
    const data = await notionFetch(`/databases/${args.database_id}/query`, 'POST', body) as Record<string, unknown>;
    return (data['results'] as unknown[]) ?? [];
  } catch (e) { return { error: String(e) }; }
}
