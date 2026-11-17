import { beforeEach, describe, expect, it } from '@jest/globals';
import { MemoryRateLimiterStore } from './fallbacks/memory-rate-limiter.store';

describe('MemoryRateLimiterStore', () => {
  let store: MemoryRateLimiterStore;

  beforeEach(() => {
    store = new MemoryRateLimiterStore();
  });

  it('allows requests within limit and tracks remaining count', async () => {
    const bucket = 'test:bucket:1';
    const limit = 3;
    const windowSeconds = 60;

    const res1 = await store.incrementAndCheck(bucket, limit, windowSeconds);
    expect(res1.allowed).toBe(true);
    expect(res1.currentCount).toBe(1);
    expect(res1.remainingCount).toBe(2);
    expect(res1.retryAfterSeconds).toBeNull();

    const res2 = await store.incrementAndCheck(bucket, limit, windowSeconds);
    expect(res2.allowed).toBe(true);
    expect(res2.currentCount).toBe(2);
    expect(res2.remainingCount).toBe(1);

    const res3 = await store.incrementAndCheck(bucket, limit, windowSeconds);
    expect(res3.allowed).toBe(true);
    expect(res3.currentCount).toBe(3);
    expect(res3.remainingCount).toBe(0);

    // 4th request exceeds limit
    const res4 = await store.incrementAndCheck(bucket, limit, windowSeconds);
    expect(res4.allowed).toBe(false);
    expect(res4.remainingCount).toBe(0);
    expect(res4.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('isolates different buckets', async () => {
    const limit = 1;
    const windowSeconds = 60;

    const resA1 = await store.incrementAndCheck(
      'bucket:A',
      limit,
      windowSeconds,
    );
    expect(resA1.allowed).toBe(true);

    const resA2 = await store.incrementAndCheck(
      'bucket:A',
      limit,
      windowSeconds,
    );
    expect(resA2.allowed).toBe(false);

    // bucket:B is independent
    const resB1 = await store.incrementAndCheck(
      'bucket:B',
      limit,
      windowSeconds,
    );
    expect(resB1.allowed).toBe(true);
  });
});
