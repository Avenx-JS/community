import { describe, expect, it } from '@jest/globals';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Pool } from 'mysql2/promise';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { RegisterDto } from '../auth/dto/register.dto';
import { CommunitiesController } from '../communities/communities.controller';
import { CreateCommunityDto } from '../communities/dto/create-community.dto';
import type { RateLimiterStore } from '../redis/redis.types';
import {
  COMMUNITY_NAME_TAKEN_SQL,
  NameAvailabilityService,
  USERNAME_TAKEN_SQL,
} from './name-availability.service';
import { RESERVED_COMMUNITY_NAMES, RESERVED_USERNAMES } from './reserved-names';

describe('NameAvailabilityService', () => {
  const setup = (taken: string[] = []) => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const service = new NameAvailabilityService({
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        // The database compares case-insensitively (utf8mb4_0900_ai_ci).
        const lower = String(values[0]).toLowerCase();
        return Promise.resolve([
          taken.some((name) => name.toLowerCase() === lower)
            ? [{ taken: 1 }]
            : [],
          [],
        ]);
      },
    } as unknown as Pool);
    return { service, calls };
  };

  describe('usernames', () => {
    it('answers free, then taken, in one statement each', async () => {
      const { service, calls } = setup(['alice']);
      await expect(service.username('bob_1')).resolves.toEqual({
        available: true,
      });
      await expect(service.username('ALICE')).resolves.toEqual({
        available: false,
        reason: 'taken',
      });
      expect(calls).toEqual([
        { sql: USERNAME_TAKEN_SQL, values: ['bob_1'] },
        { sql: USERNAME_TAKEN_SQL, values: ['ALICE'] },
      ]);
    });

    it.each([
      [undefined],
      [''],
      ['ab'],
      ['x'.repeat(51)],
      ['has space'],
      ['dash-ed'],
      [['alice', 'bob']],
      [42],
    ])('answers %p invalid with 200, querying nothing', async (value) => {
      const { service, calls } = setup();
      await expect(service.username(value)).resolves.toEqual({
        available: false,
        reason: 'invalid',
      });
      expect(calls).toEqual([]);
    });

    it.each(RESERVED_USERNAMES.flatMap((name) => [name, name.toUpperCase()]))(
      'answers %p reserved',
      async (value) => {
        await expect(setup().service.username(value)).resolves.toEqual({
          available: false,
          reason: 'reserved',
        });
      },
    );
  });

  describe('community names', () => {
    it('trims as POST /communities does, and answers taken case-insensitively', async () => {
      const { service, calls } = setup(['garden']);
      await expect(service.communityName('  Garden ')).resolves.toEqual({
        available: false,
        reason: 'taken',
      });
      expect(calls).toEqual([
        { sql: COMMUNITY_NAME_TAKEN_SQL, values: ['Garden'] },
      ]);
      await expect(service.communityName('new-garden_2')).resolves.toEqual({
        available: true,
      });
    });

    it.each([[''], ['x'.repeat(51)], ['has space'], ['dot.ted'], [null]])(
      'answers %p invalid',
      async (value) => {
        await expect(setup().service.communityName(value)).resolves.toEqual({
          available: false,
          reason: 'invalid',
        });
      },
    );

    it.each(RESERVED_COMMUNITY_NAMES.flatMap((n) => [n, n.toUpperCase()]))(
      'answers %p reserved',
      async (value) => {
        await expect(setup().service.communityName(value)).resolves.toEqual({
          available: false,
          reason: 'reserved',
        });
      },
    );
  });

  // The checks use the DTOs' own decorators; the create routes refuse what
  // the checks call reserved.
  it('shares its rules with the create DTOs', async () => {
    const usernameErrors = await validate(
      plainToInstance(RegisterDto, {
        username: 'autocomplete',
        email: 'a@example.com',
        password: 'correct-horse-battery',
      }),
    );
    expect(usernameErrors.map((error) => error.property)).toEqual(['username']);
    for (const name of RESERVED_COMMUNITY_NAMES) {
      const errors = await validate(
        plainToInstance(CreateCommunityDto, { name }),
      );
      expect(errors.map((error) => error.property)).toEqual(['name']);
    }
  });

  // Above GET /communities/:name, or a community name would answer it.
  it('declares GET /communities/name-available before /communities/:name', () => {
    const paths = Object.getOwnPropertyNames(CommunitiesController.prototype)
      .map((name) => {
        const handler = (
          CommunitiesController.prototype as unknown as Record<string, object>
        )[name];
        return typeof handler === 'function' &&
          Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.GET
          ? (Reflect.getMetadata(PATH_METADATA, handler) as string)
          : null;
      })
      .filter((path): path is string => path !== null);
    expect(paths.indexOf('name-available')).toBeGreaterThan(-1);
    expect(paths.indexOf('name-available')).toBeLessThan(
      paths.indexOf(':name'),
    );
  });
});

describe('availability rate limits', () => {
  const withEnv = async (
    values: Record<string, string>,
    run: () => Promise<void>,
  ) => {
    const previous = Object.fromEntries(
      Object.keys(values).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, values);
    try {
      await run();
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  it('gives each check its own bucket: per IP for usernames, per account for community names', async () => {
    await withEnv(
      {
        AUTH_USERNAME_AVAILABLE_IP_MAX: '7',
        AUTH_USERNAME_AVAILABLE_IP_WINDOW_SECONDS: '11',
        API_COMMUNITY_NAME_AVAILABLE_ACCOUNT_MAX: '5',
        API_COMMUNITY_NAME_AVAILABLE_ACCOUNT_WINDOW_SECONDS: '17',
      },
      async () => {
        const buckets: Array<{ key: string; limit: number; window: number }> =
          [];
        const store: RateLimiterStore = {
          incrementAndCheck: (key, limit, window) => {
            buckets.push({ key, limit, window });
            return Promise.resolve({
              allowed: true,
              currentCount: 1,
              remainingCount: limit - 1,
              retryAfterSeconds: null,
            });
          },
        };
        const service = new AuthRateLimitService({} as Pool, store);
        const count = async (
          path: string,
          limit: number,
          window: number,
          account?: string,
        ) => {
          buckets.length = 0;
          await service.enforceApiRequest('192.0.2.1', 'GET', path, account);
          return buckets.filter((b) => b.limit === limit && b.window === window)
            .length;
        };
        expect(await count('/auth/username-available', 7, 11)).toBe(1);
        expect(await count('/auth/register', 7, 11)).toBe(0);
        expect(await count('/communities/name-available', 5, 17, 'u-1')).toBe(
          1,
        );
        expect(await count('/communities/garden', 5, 17, 'u-1')).toBe(0);
      },
    );
  });
});
