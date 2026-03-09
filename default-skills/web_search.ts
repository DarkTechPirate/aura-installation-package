export async function search(args: { query: string; num?: number }, _ctx: unknown): Promise<unknown> {
  const num = args.num ?? 5;
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_redirect=1&no_html=1`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json() as Record<string, unknown>;
    const results: Array<{ title: string; snippet: string; url: string }> = [];

    // Extract from RelatedTopics
    const topics = (data['RelatedTopics'] as Array<Record<string, unknown>>) ?? [];
    for (const t of topics.slice(0, num)) {
      if (t['Text'] && t['FirstURL']) {
        const text = String(t['Text']);
        results.push({
          title:   text.split(' - ')[0] ?? text,
          snippet: text,
          url:     String(t['FirstURL']),
        });
      }
    }

    // AbstractText fallback
    if (results.length === 0 && data['AbstractText']) {
      results.push({
        title:   String(data['Heading'] ?? args.query),
        snippet: String(data['AbstractText']),
        url:     String(data['AbstractURL'] ?? ''),
      });
    }

    // Last resort: link to search
    if (results.length === 0) {
      results.push({
        title:   args.query,
        snippet: `No instant results. Search: https://duckduckgo.com/?q=${encodeURIComponent(args.query)}`,
        url:     `https://duckduckgo.com/?q=${encodeURIComponent(args.query)}`,
      });
    }

    return results;
  } catch (e) {
    return [{ title: 'Search Error', snippet: String(e), url: '' }];
  }
}
