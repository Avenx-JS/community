import { beforeEach, describe, expect, it } from '@jest/globals';
import { MemoryCacheService } from './fallbacks/memory-cache.service';

describe('MemoryCacheService', () => {
  let cache: MemoryCacheService;

  beforeEach(() => {
    cache = new MemoryCacheService();
  });

  it('sets and gets cached values', async () => {
    await cache.set('key1', { foo: 'bar' });
    const result = await cache.get<{ foo: string }>('key1');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('returns null for missing or expired keys', async () => {
    expect(await cache.get('missing')).toBeNull();

    await cache.set('short-lived', 'value', { ttlSeconds: -1 });
    expect(await cache.get('short-lived')).toBeNull();
  });

  it('deletes by key and by pattern', async () => {
    await cache.set('post:1', 'p1');
    await cache.set('post:2', 'p2');
    await cache.set('user:1', 'u1');

    await cache.del('post:1');
    expect(await cache.get('post:1')).toBeNull();
    expect(await cache.get('post:2')).toBe('p2');

    await cache.delByPattern('post:*');
    expect(await cache.get('post:2')).toBeNull();
    expect(await cache.get('user:1')).toBe('u1');
  });

  it('implements getOrSet', async () => {
    let callCount = 0;
    const factory = (): Promise<{ count: number }> => {
      callCount++;
      return Promise.resolve({ count: callCount });
    };

    const res1 = await cache.getOrSet('counter', factory, { ttlSeconds: 60 });
    expect(res1).toEqual({ count: 1 });
    expect(callCount).toBe(1);

    const res2 = await cache.getOrSet('counter', factory, { ttlSeconds: 60 });
    expect(res2).toEqual({ count: 1 });
    expect(callCount).toBe(1);
  });
});
