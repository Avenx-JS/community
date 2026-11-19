import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { ApiRateLimitInterceptor } from '../src/common/api-rate-limit.interceptor';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import { AUTOCOMPLETE_SQL } from '../src/users/user-autocomplete.service';

// GET /users/autocomplete through the real controller, service and rate
// limiter (the app's own store), with a fake pool for the one statement.
describe('User autocomplete (e2e)', () => {
  let app: INestApplication<App>;
  let calls: unknown[][];
  const previous = {
    max: process.env.API_AUTOCOMPLETE_ACCOUNT_MAX,
    window: process.env.API_AUTOCOMPLETE_ACCOUNT_WINDOW_SECONDS,
  };

  beforeEach(async () => {
    process.env.API_AUTOCOMPLETE_ACCOUNT_MAX = '3';
    process.env.API_AUTOCOMPLETE_ACCOUNT_WINDOW_SECONDS = '60';
    calls = [];
    const run = (sql: string, values: unknown[] = []) => {
      if (sql === AUTOCOMPLETE_SQL) {
        calls.push(values);
        return Promise.resolve([
          [
            {
              username: 'maintainer',
              display_name: 'The Maintainer',
              avatar_media_id: null,
            },
          ],
          [],
        ]);
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    };
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute: run,
        getConnection: () => Promise.reject(new Error('no transaction')),
      })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            token === 'user-token'
              ? { kind: 'valid', emailVerified: true, userId: 'u-caller' }
              : { kind: 'invalid' },
          ),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
    // As main.ts registers it.
    app.useGlobalInterceptors(
      new ApiRateLimitInterceptor(app.get(AuthRateLimitService)),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const [name, value] of [
      ['API_AUTOCOMPLETE_ACCOUNT_MAX', previous.max],
      ['API_AUTOCOMPLETE_ACCOUNT_WINDOW_SECONDS', previous.window],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const get = (query: string, token: string | null = 'user-token') => {
    const test = request(app.getHttpServer()).get(
      `/users/autocomplete${query}`,
    );
    return token ? test.set('Authorization', `Bearer ${token}`) : test;
  };

  it('needs a token: no anonymous enumeration', async () => {
    await get('?q=ma', null).expect(401);
    await get('?q=ma', 'bad-token').expect(401);
    expect(calls).toEqual([]);
  });

  it('answers suggestions for the caller, a leading @ ignored', async () => {
    const response = await get('?q=%40ma').expect(200);
    expect(response.body).toEqual({
      items: [
        {
          username: 'maintainer',
          display_name: 'The Maintainer',
          avatar_url: null,
        },
      ],
    });
    expect(calls).toEqual([
      ['u-caller', 'ma%', 'ma%', 'u-caller', 'u-caller', 'ma%'],
    ]);
  });

  it.each(['', '?q=m', '?q=%40m', `?q=${'x'.repeat(51)}`, '?q=ma&limit=50'])(
    'rejects %p with 400',
    async (query) => {
      await get(query).expect(400);
      expect(calls).toEqual([]);
    },
  );

  // Its own per-account bucket (API_AUTOCOMPLETE_ACCOUNT_*), here 3.
  it('limits each account, answering 429 with Retry-After', async () => {
    for (let i = 0; i < 3; i += 1) {
      await get('?q=ma').expect(200);
    }
    const limited = await get('?q=ma').expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(calls).toHaveLength(3);
  });

  // users/autocomplete is a route, not a profile.
  it('takes precedence over /users/:username', async () => {
    await get('?q=ma').expect(200);
  });
});
