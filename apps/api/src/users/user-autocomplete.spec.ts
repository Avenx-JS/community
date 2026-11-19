import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Pool } from 'mysql2/promise';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { RegisterDto } from '../auth/dto/register.dto';
import { RESERVED_USERNAMES } from '../auth/dto/reserved-username';
import type { RateLimiterStore } from '../redis/redis.types';
import { AutocompleteUsersDto } from './dto/autocomplete-users.dto';
import {
  AUTOCOMPLETE_LIMIT,
  AUTOCOMPLETE_SQL,
  UserAutocompleteService,
} from './user-autocomplete.service';

describe('UserAutocompleteService', () => {
  const run = async (avatarRows: unknown[] = []) => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const service = new UserAutocompleteService({
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve([
          sql === AUTOCOMPLETE_SQL
            ? [
                {
                  username: 'maintainer',
                  display_name: 'Main',
                  avatar_media_id: 'm-1',
                },
                {
                  username: 'mallory',
                  display_name: null,
                  avatar_media_id: null,
                },
              ]
            : avatarRows,
          [],
        ]);
      },
    } as unknown as Pool);
    return { calls, result: await service.suggest('caller', ' ma_% ') };
  };

  it('matches by an escaped prefix, excluding the caller and blocks either way, at most 10', async () => {
    const { calls } = await run();
    expect(calls[0]).toEqual({
      sql: AUTOCOMPLETE_SQL,
      values: ['caller', 'ma=_=%%', 'ma=_=%%', 'caller', 'caller', 'ma=_=%%'],
    });
    expect(AUTOCOMPLETE_SQL).toContain('u.deleted_at IS NULL');
    expect(AUTOCOMPLETE_SQL).toContain('u.id <> ?');
    expect(AUTOCOMPLETE_SQL).toContain(
      'FROM user_blocks WHERE blocker_id = u.id AND blocked_id = ?',
    );
    expect(AUTOCOMPLETE_SQL).toContain(
      'FROM user_blocks WHERE blocker_id = ? AND blocked_id = u.id',
    );
    expect(AUTOCOMPLETE_SQL).toMatch(
      new RegExp(`LIMIT ${AUTOCOMPLETE_LIMIT}$`),
    );
    expect(AUTOCOMPLETE_LIMIT).toBe(10);
  });

  it('answers username, display name and avatar URL, loading avatars in one statement', async () => {
    const { calls, result } = await run([
      {
        id: 'm-1',
        kind: 'image',
        mime_type: 'image/png',
        size_bytes: 10,
        width: 1,
        height: 1,
        storage_key: 'ab/m-1.png',
        created_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    expect(calls).toHaveLength(2);
    expect(result.items).toEqual([
      {
        username: 'maintainer',
        display_name: 'Main',
        // The media DTO's URL, whatever MEDIA_PUBLIC_BASE_URL makes of it.
        avatar_url: expect.stringContaining('m-1'),
      },
      { username: 'mallory', display_name: null, avatar_url: null },
    ]);
  });
});

describe('AutocompleteUsersDto', () => {
  const check = (q: unknown) =>
    validate(plainToInstance(AutocompleteUsersDto, { q }));

  it.each([['ma'], ['@ma'], ['Mai Tainer']])('accepts %p', async (q) => {
    expect(await check(q)).toEqual([]);
  });

  it.each([[undefined], ['m'], ['@m'], ['x'.repeat(51)], ['a\u0000b']])(
    'rejects %p',
    async (q) => {
      expect((await check(q)).length).toBeGreaterThan(0);
    },
  );
});

// /users/autocomplete is a route, so no account may be named autocomplete.
describe('reserved usernames', () => {
  it.each(RESERVED_USERNAMES.flatMap((name) => [name, name.toUpperCase()]))(
    'refuses registering %p',
    async (username) => {
      const errors = await validate(
        plainToInstance(RegisterDto, {
          username,
          email: 'someone@example.com',
          password: 'correct-horse-battery',
        }),
      );
      expect(errors.map((error) => error.property)).toEqual(['username']);
    },
  );
});

describe('autocomplete rate limit', () => {
  it('gives GET /users/autocomplete its own per-account bucket, and only it', async () => {
    const names = [
      'API_AUTOCOMPLETE_ACCOUNT_MAX',
      'API_AUTOCOMPLETE_ACCOUNT_WINDOW_SECONDS',
    ];
    const previous = names.map((name) => process.env[name]);
    // Values no other bucket uses, so the bucket is told apart.
    process.env.API_AUTOCOMPLETE_ACCOUNT_MAX = '7';
    process.env.API_AUTOCOMPLETE_ACCOUNT_WINDOW_SECONDS = '13';
    try {
      const buckets: Array<{ limit: number; window: number }> = [];
      const store: RateLimiterStore = {
        incrementAndCheck: (_key, limit, window) => {
          buckets.push({ limit, window });
          return Promise.resolve({
            allowed: true,
            currentCount: 1,
            remainingCount: limit - 1,
            retryAfterSeconds: null,
          });
        },
      };
      const service = new AuthRateLimitService({} as Pool, store);
      const count = async (method: string, path: string, account?: string) => {
        buckets.length = 0;
        await service.enforceApiRequest('192.0.2.1', method, path, account);
        return buckets.filter((b) => b.limit === 7 && b.window === 13).length;
      };
      expect(await count('GET', '/users/autocomplete', 'u-1')).toBe(1);
      expect(await count('GET', '/users/someone', 'u-1')).toBe(0);
      expect(await count('POST', '/users/autocomplete', 'u-1')).toBe(0);
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = previous[index];
        }
      });
    }
  });
});
