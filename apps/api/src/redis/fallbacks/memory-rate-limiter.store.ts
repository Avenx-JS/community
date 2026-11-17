import { Injectable } from '@nestjs/common';
import { RateLimiterStore, RateLimitResult } from '../redis.types';

interface MemoryBucket {
  timestamps: number[];
}

@Injectable()
export class MemoryRateLimiterStore extends RateLimiterStore {
  private readonly buckets = new Map<string, MemoryBucket>();
  private lastPrunedAt = Date.now();

  incrementAndCheck(
    bucketKey: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    this.maybePrune(now);

    const windowMs = windowSeconds * 1000;
    const clearBefore = now - windowMs;

    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(bucketKey, bucket);
    }

    // Filter out expired timestamps
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > clearBefore);

    const currentCount = bucket.timestamps.length;
    if (currentCount < limit) {
      bucket.timestamps.push(now);
      return Promise.resolve({
        allowed: true,
        currentCount: currentCount + 1,
        remainingCount: limit - currentCount - 1,
        retryAfterSeconds: null,
      });
    }

    // Rate limited
    const oldest = bucket.timestamps[0] ?? now;
    const retryAfterMs = oldest + windowMs - now;
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

    return Promise.resolve({
      allowed: false,
      currentCount,
      remainingCount: 0,
      retryAfterSeconds,
    });
  }

  private maybePrune(now: number): void {
    // Prune stale buckets at most once every 60 seconds
    if (now - this.lastPrunedAt < 60_000) {
      return;
    }
    this.lastPrunedAt = now;
    for (const [key, bucket] of this.buckets.entries()) {
      if (
        bucket.timestamps.length === 0 ||
        bucket.timestamps[bucket.timestamps.length - 1] < now - 3600_000
      ) {
        this.buckets.delete(key);
      }
    }
  }
}
