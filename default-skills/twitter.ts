function getClient() {
  const apiKey    = process.env['TWITTER_API_KEY'];
  const apiSecret = process.env['TWITTER_API_SECRET'];
  const accToken  = process.env['TWITTER_ACCESS_TOKEN'];
  const accSecret = process.env['TWITTER_ACCESS_SECRET'];
  if (!apiKey || !apiSecret || !accToken || !accSecret) {
    throw new Error('TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET required');
  }
  return { apiKey, apiSecret, accToken, accSecret };
}

// Dynamic import to avoid hard-dep at load time
async function getApi() {
  getClient(); // validate env first
  const { TwitterApi } = await import('twitter-api-v2');
  const { apiKey, apiSecret, accToken, accSecret } = getClient();
  return new TwitterApi({ appKey: apiKey, appSecret: apiSecret, accessToken: accToken, accessSecret: accSecret });
}

export async function twitter_post(args: { text: string }, _ctx: unknown): Promise<unknown> {
  try {
    const api = await getApi();
    const tweet = await api.v2.tweet(args.text);
    return { url: `https://twitter.com/i/web/status/${tweet.data.id}` };
  } catch (e) { return { error: String(e) }; }
}

export async function twitter_thread(args: { tweets: string[] }, _ctx: unknown): Promise<unknown> {
  try {
    const api = await getApi();
    let replyTo: string | undefined;
    let firstUrl = '';
    for (const text of args.tweets) {
      const opts = replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {};
      const t = await api.v2.tweet(text, opts);
      if (!replyTo) firstUrl = `https://twitter.com/i/web/status/${t.data.id}`;
      replyTo = t.data.id;
    }
    return { url: firstUrl };
  } catch (e) { return { error: String(e) }; }
}

export async function twitter_reply(args: { tweet_id: string; text: string }, _ctx: unknown): Promise<unknown> {
  try {
    const api = await getApi();
    const t = await api.v2.tweet(args.text, { reply: { in_reply_to_tweet_id: args.tweet_id } });
    return { url: `https://twitter.com/i/web/status/${t.data.id}` };
  } catch (e) { return { error: String(e) }; }
}

export async function twitter_search(args: { query: string; count?: number }, _ctx: unknown): Promise<unknown> {
  try {
    const api = await getApi();
    const results = await api.v2.search(args.query, { max_results: args.count ?? 10 });
    return results.data?.data ?? [];
  } catch (e) { return { error: String(e) }; }
}

export async function twitter_get_timeline(args: { count?: number }, _ctx: unknown): Promise<unknown> {
  try {
    const api = await getApi();
    const me = await api.v2.me();
    const timeline = await api.v2.homeTimeline({ max_results: args.count ?? 20 });
    return timeline.data?.data ?? [];
  } catch (e) { return { error: String(e) }; }
}
