import { Injectable } from '@nestjs/common';
import { CacheOptions, CacheService } from '../redis.types';

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number | null;
}

@Injectable()
export class MemoryCacheService extends CacheService {
  private readonly store = new Map<string, CacheEntry>();

  get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return Promise.resolve(null);
    }

    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
    const ttlSeconds = options?.ttlSeconds;
    const expiresAt =
      typeof ttlSeconds === 'number' ? Date.now() + ttlSeconds * 1000 : null;

    this.store.set(key, { value, expiresAt });
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  delByPattern(pattern: string): Promise<void> {
    // Converts redis pattern (e.g. "prefix:*") to regex
    const regexPattern = '^' + pattern.replace(/\*/g, '.*') + '$';
    const regex = new RegExp(regexPattern);

    for (const key of this.store.keys()) {
      if (regex.test(key)) {
        this.store.delete(key);
      }
    }
    return Promise.resolve();
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
