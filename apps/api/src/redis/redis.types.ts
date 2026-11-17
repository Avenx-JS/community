export interface RedisConfig {
  enabled: boolean;
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
  tls: boolean;
}

export interface CacheOptions {
  ttlSeconds?: number;
}

export abstract class CacheService {
  abstract get<T>(key: string): Promise<T | null>;
  abstract set<T>(key: string, value: T, options?: CacheOptions): Promise<void>;
  abstract del(key: string): Promise<void>;
  abstract delByPattern(pattern: string): Promise<void>;
  abstract getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    options?: CacheOptions,
  ): Promise<T>;
}

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remainingCount: number;
  retryAfterSeconds: number | null;
}

export abstract class RateLimiterStore {
  abstract incrementAndCheck(
    bucketKey: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const REDIS_SUBSCRIBER_CLIENT = Symbol('REDIS_SUBSCRIBER_CLIENT');
