import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { RateLimiterStore, RateLimitResult, REDIS_CLIENT } from './redis.types';
import { MemoryRateLimiterStore } from './fallbacks/memory-rate-limiter.store';

// Atomic sliding window log in Redis Lua
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local clearBefore = now - window

redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
local currentRequests = redis.call('ZCARD', key)

if currentRequests < limit then
    redis.call('ZADD', key, now, now)
    redis.call('PEXPIRE', key, window + 1000)
    return { 1, limit - currentRequests - 1, 0 }
else
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retryAfterSeconds = 1
    if oldest and #oldest >= 2 then
        local oldestScore = tonumber(oldest[2])
        local retryAfterMs = (oldestScore + window) - now
        retryAfterSeconds = math.ceil(retryAfterMs / 1000)
        if retryAfterSeconds < 1 then retryAfterSeconds = 1 end
    end
    return { 0, 0, retryAfterSeconds }
end
`;

@Injectable()
export class RedisRateLimiterStore extends RateLimiterStore {
  private readonly logger = new Logger(RedisRateLimiterStore.name);
  private readonly fallback = new MemoryRateLimiterStore();

  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis?: Redis | null,
  ) {
    super();
  }

  async incrementAndCheck(
    bucketKey: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    if (!this.redis) {
      return this.fallback.incrementAndCheck(bucketKey, limit, windowSeconds);
    }

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const key = `rl:${bucketKey}`;

    try {
      const result = (await this.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        now,
        windowMs,
        limit,
      )) as [number, number, number];

      const [allowed, remainingCount, retryAfterSeconds] = result;
      return {
        allowed: allowed === 1,
        currentCount: limit - remainingCount,
        remainingCount,
        retryAfterSeconds: allowed === 1 ? null : retryAfterSeconds,
      };
    } catch (error) {
      this.logger.warn(
        `Redis rate-limit failed, using memory fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.fallback.incrementAndCheck(bucketKey, limit, windowSeconds);
    }
  }
}
