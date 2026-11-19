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
import {
  COMMUNITY_NAME_TAKEN_SQL,
  USERNAME_TAKEN_SQL,
} from '../src/common/name-availability.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';

const LIMITS = {
  AUTH_USERNAME_AVAILABLE_IP_MAX: '4',
  AUTH_USERNAME_AVAILABLE_IP_WINDOW_SECONDS: '60',
  API_COMMUNITY_NAME_AVAILABLE_ACCOUNT_MAX: '3',
  API_COMMUNITY_NAME_AVAILABLE_ACCOUNT_WINDOW_SECONDS: '60',
};

// Both availability checks through the real controllers, service and rate
// limiter (registered as main.ts registers it, with the app's own store).
describe('Name availability (e2e)', () => {
  let app: INestApplication<App>;
  let lookups: unknown[][];
  const previous = Object.fromEntries(
    Object.keys(LIMITS).map((name) => [name, process.env[name]]),
  );

  beforeEach(async () => {
    Object.assign(process.env, LIMITS);
    lookups = [];
    const taken: Record<string, string[] | undefined> = {
      [USERNAME_TAKEN_SQL]: ['alice'],
      [COMMUNITY_NAME_TAKEN_SQL]: ['garden'],
    };
    const run = (sql: string, values: unknown[] = []) => {
      const names = taken[sql];
      if (!names) return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      lookups.push(values);
      const lower = String(values[0]).toLowerCase();
      return Promise.resolve([names.includes(lower) ? [{ taken: 1 }] : [], []]);
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
              ? { kind: 'valid', emailVerified: true, userId: 'u-1' }
              : { kind: 'invalid' },
          ),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
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
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const get = (path: string, token: string | null = null) => {
    const test = request(app.getHttpServer()).get(path);
    return token ? test.set('Authorization', `Bearer ${token}`) : test;
  };

  describe('GET /auth/username-available', () => {
    it.each([
      ['bob_1', { available: true }],
      ['Alice', { available: false, reason: 'taken' }],
      ['ab', { available: false, reason: 'invalid' }],
      ['AutoComplete', { available: false, reason: 'reserved' }],
    ])('answers %p with %o, publicly', async (username, body) => {
      await get(`/auth/username-available?username=${username}`).expect(
        200,
        body,
      );
    });

    it('answers a missing or repeated parameter invalid, never 400', async () => {
      await get('/auth/username-available').expect(200, {
        available: false,
        reason: 'invalid',
      });
      await get('/auth/username-available?username=a&username=b').expect(200, {
        available: false,
        reason: 'invalid',
      });
      expect(lookups).toEqual([]);
    });

    it('is limited per IP, answering 429 with Retry-After', async () => {
      for (let i = 0; i < 4; i += 1) {
        await get('/auth/username-available?username=bob_1').expect(200);
      }
      const limited = await get(
        '/auth/username-available?username=bob_1',
      ).expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(lookups).toHaveLength(4);
    });
  });

  describe('GET /communities/name-available', () => {
    it('needs a token', async () => {
      await get('/communities/name-available?name=new').expect(401);
      expect(lookups).toEqual([]);
    });

    it.each([
      ['new-garden', { available: true }],
      ['GARDEN', { available: false, reason: 'taken' }],
      ['has%20space', { available: false, reason: 'invalid' }],
      ['trending', { available: false, reason: 'reserved' }],
      ['name-available', { available: false, reason: 'reserved' }],
    ])('answers %p with %o', async (name, body) => {
      await get(
        `/communities/name-available?name=${name}`,
        'user-token',
      ).expect(200, body);
    });

    it('is limited per account', async () => {
      for (let i = 0; i < 3; i += 1) {
        await get('/communities/name-available?name=new', 'user-token').expect(
          200,
        );
      }
      await get('/communities/name-available?name=new', 'user-token').expect(
        429,
      );
    });
  });
});
