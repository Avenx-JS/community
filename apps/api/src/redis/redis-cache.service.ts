import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { CacheOptions, CacheService, REDIS_CLIENT } from './redis.types';
import { MemoryCacheService } from './fallbacks/memory-cache.service';

@Injectable()
export class RedisCacheService extends CacheService {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly fallback = new MemoryCacheService();

  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis?: Redis | null,
  ) {
    super();
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.redis) {
      return this.fallback.get<T>(key);
    }

    try {
      const data = await this.redis.get(`cache:${key}`);
      if (!data) {
        return null;
      }
      return JSON.parse(data) as T;
    } catch (error) {
      this.logger.warn(
        `Redis cache get failed for key "${key}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.fallback.get<T>(key);
    }
  }

  async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
    if (!this.redis) {
      return this.fallback.set<T>(key, value, options);
    }

    try {
      const serialized = JSON.stringify(value);
      const prefixedKey = `cache:${key}`;
      const ttl = options?.ttlSeconds;

      if (typeof ttl === 'number' && ttl > 0) {
        await this.redis.set(prefixedKey, serialized, 'EX', ttl);
      } else {
        await this.redis.set(prefixedKey, serialized);
      }
    } catch (error) {
      this.logger.warn(
        `Redis cache set failed for key "${key}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.fallback.set<T>(key, value, options);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.redis) {
      return this.fallback.del(key);
    }

    try {
      await this.redis.del(`cache:${key}`);
    } catch (error) {
      this.logger.warn(
        `Redis cache del failed for key "${key}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.fallback.del(key);
  }

  async delByPattern(pattern: string): Promise<void> {
    if (!this.redis) {
      return this.fallback.delByPattern(pattern);
    }

    try {
      const matchPattern = `*cache:${pattern}`;
      const stream = this.redis.scanStream({
        match: matchPattern,
        count: 100,
      });

      const keysToDelete: string[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (keys: string[]) => {
          if (keys.length > 0) {
            keysToDelete.push(...keys);
          }
        });
        stream.on('end', () => resolve());
        stream.on('error', (err) => reject(err));
      });

      if (keysToDelete.length > 0) {
        // Unlink or delete in batches
        await this.redis.unlink(...keysToDelete);
      }
    } catch (error) {
      this.logger.warn(
        `Redis cache delByPattern failed for "${pattern}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.fallback.delByPattern(pattern);
  }

  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    options?: CacheOptions,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null && cached !== undefined) {
      return cached;
    }

    const value = await factory();
    await this.set(key, value, options);
    return value;
  }
}
