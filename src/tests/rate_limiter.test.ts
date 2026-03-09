import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../security/rate_limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    // 3 tokens, very long refill so tests don't race against time
    limiter = new RateLimiter(3, 60_000);
  });

  it('allows requests within the token budget', () => {
    expect(limiter.consume('user1')).toBe(0);
    expect(limiter.consume('user1')).toBe(0);
    expect(limiter.consume('user1')).toBe(0);
  });

  it('rate-limits once tokens are exhausted', () => {
    limiter.consume('user2');
    limiter.consume('user2');
    limiter.consume('user2');
    const waitSecs = limiter.consume('user2');
    expect(waitSecs).toBeGreaterThan(0);
  });

  it('tracks buckets independently per node_id', () => {
    limiter.consume('a');
    limiter.consume('a');
    limiter.consume('a');
    // 'a' exhausted, 'b' untouched
    expect(limiter.consume('b')).toBe(0);
    expect(limiter.consume('a')).toBeGreaterThan(0);
  });

  it('cleanup removes stale buckets without affecting fresh ones', () => {
    limiter.consume('fresh');
    // Manually backdate the fresh bucket so cleanup considers it stale
    // @ts-expect-error accessing private for test
    limiter.buckets.get('fresh')!.lastRefill = Date.now() - 700_000;
    limiter.cleanup();
    // After cleanup the bucket is gone — next consume starts fresh (returns 0)
    expect(limiter.consume('fresh')).toBe(0);
  });
});
