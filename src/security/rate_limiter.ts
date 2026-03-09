// Token bucket: refills 20 tokens per 60 seconds per node
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private readonly MAX_TOKENS: number;
  private readonly REFILL_INTERVAL_MS: number;

  constructor(maxTokens = 20, refillIntervalMs = 60_000) {
    this.MAX_TOKENS = maxTokens;
    this.REFILL_INTERVAL_MS = refillIntervalMs;
  }

  /** Returns 0 if allowed, or seconds to wait if rate-limited */
  consume(nodeId: string): number {
    const now = Date.now();
    let bucket = this.buckets.get(nodeId);
    if (!bucket) {
      bucket = { tokens: this.MAX_TOKENS, lastRefill: now };
      this.buckets.set(nodeId, bucket);
    }
    // Refill proportionally
    const elapsed = now - bucket.lastRefill;
    const refilled = (elapsed / this.REFILL_INTERVAL_MS) * this.MAX_TOKENS;
    bucket.tokens = Math.min(this.MAX_TOKENS, bucket.tokens + refilled);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    // How long until 1 token refills
    return Math.ceil((1 - bucket.tokens) * (this.REFILL_INTERVAL_MS / this.MAX_TOKENS) / 1000);
  }

  /** Remove buckets not seen in 10 minutes */
  cleanup(): void {
    const cutoff = Date.now() - 600_000;
    for (const [id, b] of this.buckets) {
      if (b.lastRefill < cutoff) this.buckets.delete(id);
    }
  }
}
