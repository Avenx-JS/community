import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { MYSQL_POOL } from '../src/auth/auth.service';
import { ApiRateLimitInterceptor } from '../src/common/api-rate-limit.interceptor';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import {
  COMMENT_STATS_SQL,
  MEMBER_COUNT_SQL,
  MODERATOR_COUNT_SQL,
  POST_STATS_SQL,
  STATS_COMMUNITY_SQL,
} from '../src/communities/community-stats.service';

interface StatsResponse {
  member_count: number;
  moderator_count: number;
  post_count: number;
  comment_count: number;
  created_at: string;
  last_post_at: string | null;
  posts_last_7_days: number;
  comments_last_7_days: number;
}

const FIELDS = [
  'comment_count',
  'comments_last_7_days',
  'created_at',
  'last_post_at',
  'member_count',
  'moderator_count',
  'post_count',
  'posts_last_7_days',
];

// The database clock the fake evaluates the seven-day window against.
const DB_NOW = new Date('2026-11-03T12:00:00.000Z');
const daysAgo = (days: number) => new Date(DB_NOW.getTime() - days * 86400000);

describe('Community stats API (e2e)', () => {
  let app: INestApplication<App>;
  let statements: Array<{ sql: string; values: unknown[] }>;
  let rateLimited: Array<{ method: string; path: string }>;

  beforeEach(async () => {
    statements = [];
    rateLimited = [];
    const communities = [
      {
        id: 'community-a',
        name: 'gardening',
        creator_id: 'user-creator',
        created_at: new Date('2026-01-14T09:12:00.000Z'),
        deleted_at: null as Date | null,
      },
      {
        id: 'community-b',
        name: 'quiet',
        creator_id: 'user-creator',
        created_at: new Date('2026-02-01T00:00:00.000Z'),
        deleted_at: null,
      },
      {
        id: 'community-c',
        name: 'gone',
        creator_id: 'user-creator',
        created_at: new Date('2026-03-01T00:00:00.000Z'),
        deleted_at: new Date('2026-10-01T00:00:00.000Z'),
      },
    ];
    // Per-row data the response must never carry.
    const users = new Map([
      ['user-creator', { email: 'creator@example.com', deleted: false }],
      ['user-1', { email: 'one@example.com', deleted: false }],
      ['user-2', { email: 'two@example.com', deleted: false }],
      ['user-3', { email: 'three@example.com', deleted: false }],
      ['user-gone', { email: 'gone@invalid', deleted: true }],
    ]);
    const subscriptions = [
      ['user-1', 'community-a'],
      ['user-2', 'community-a'],
      ['user-3', 'community-a'],
      ['user-gone', 'community-a'],
    ];
    const moderators = [
      ['community-a', 'user-1'],
      // The creator's self-appointment is not counted as a moderator.
      ['community-a', 'user-creator'],
      ['community-a', 'user-gone'],
    ];
    const posts = [
      { id: 'p1', community_id: 'community-a', created_at: daysAgo(30) },
      { id: 'p2', community_id: 'community-a', created_at: daysAgo(6) },
      { id: 'p3', community_id: 'community-a', created_at: daysAgo(1) },
      { id: 'p4', community_id: 'community-b-other', created_at: daysAgo(1) },
    ];
    const comments = [
      { post_id: 'p1', created_at: daysAgo(29) },
      { post_id: 'p1', created_at: daysAgo(8) },
      { post_id: 'p2', created_at: daysAgo(5) },
      { post_id: 'p3', created_at: daysAgo(0.5) },
      { post_id: 'p4', created_at: daysAgo(0.5) },
    ];
    const windowStart = daysAgo(7).getTime();
    const live = (userId: string) => !users.get(userId)?.deleted;

    const result = (rows: unknown) =>
      Promise.resolve([rows, []] as [unknown, unknown]);
    const execute = (sql: string, values: unknown[]) => {
      statements.push({ sql, values });
      if (sql === STATS_COMMUNITY_SQL) {
        expect(sql).toContain('deleted_at IS NULL');
        // Values: the viewer (null without a token), the name.
        return result(
          communities
            .filter((c) => c.name === values[1] && c.deleted_at === null)
            .map(({ id, creator_id, created_at }) => ({
              id,
              creator_id,
              created_at,
              access_visibility: 'public',
              access_member: 0,
            })),
        );
      }
      const [communityId] = values as [string];
      if (sql === MEMBER_COUNT_SQL) {
        return result([
          {
            total: subscriptions.filter(
              ([userId, community]) =>
                community === communityId && live(userId),
            ).length,
          },
        ]);
      }
      if (sql === MODERATOR_COUNT_SQL) {
        const creatorId = values[1];
        return result([
          {
            total: moderators.filter(
              ([community, userId]) =>
                community === communityId &&
                userId !== creatorId &&
                live(userId),
            ).length,
          },
        ]);
      }
      if (sql === POST_STATS_SQL) {
        const own = posts.filter((post) => post.community_id === communityId);
        const newest = own
          .map((post) => post.created_at)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        return result([
          {
            total: own.length,
            last_post_at: newest ?? null,
            recent: String(
              own.filter((post) => post.created_at.getTime() >= windowStart)
                .length,
            ),
          },
        ]);
      }
      if (sql === COMMENT_STATS_SQL) {
        const postIds = new Set(
          posts
            .filter((post) => post.community_id === communityId)
            .map((post) => post.id),
        );
        const own = comments.filter((comment) => postIds.has(comment.post_id));
        return result([
          {
            total: own.length,
            recent: String(
              own.filter((c) => c.created_at.getTime() >= windowStart).length,
            ),
          },
        ]);
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({ execute })
      .overrideProvider(AuthRateLimitService)
      .useValue({
        enforceApiRequest: (_ip: string, method: string, path: string) => {
          rateLimited.push({ method, path });
          return Promise.resolve(null);
        },
      })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
    // Installed in main.ts, so tests that exercise it install it too.
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
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it('returns every figure without a token', async () => {
    const response = await get('/communities/gardening/stats').expect(200);
    const body = response.body as StatsResponse;

    expect(Object.keys(body).sort()).toEqual(FIELDS);
    expect(body).toEqual({
      // user-gone's subscription is not counted.
      member_count: 3,
      // user-1 only: not the creator's self-appointment, not user-gone.
      moderator_count: 1,
      post_count: 3,
      comment_count: 4,
      created_at: '2026-01-14T09:12:00.000Z',
      last_post_at: daysAgo(1).toISOString(),
      // p2 (6 days) and p3 (1 day); p1 is 30 days old.
      posts_last_7_days: 2,
      // On p2 (5 days) and p3 (half a day); p1's are 29 and 8 days old.
      comments_last_7_days: 2,
    });
  });

  it('returns zeros and a present null last_post_at for an empty community', async () => {
    const response = await get('/communities/quiet/stats').expect(200);

    expect(response.body).toEqual({
      member_count: 0,
      moderator_count: 0,
      post_count: 0,
      comment_count: 0,
      created_at: '2026-02-01T00:00:00.000Z',
      last_post_at: null,
      posts_last_7_days: 0,
      comments_last_7_days: 0,
    });
    expect(JSON.stringify(response.body)).toContain('"last_post_at":null');
  });

  it.each(['/communities/unknown/stats', '/communities/gone/stats'])(
    'answers 404 for %s without aggregating',
    async (path) => {
      await get(path).expect(404);
      expect(statements).toHaveLength(1);
    },
  );

  it.each([
    '/communities/bad.name/stats',
    '/communities/gardening/stats?days=30',
    '/communities/gardening/stats?from=2026-01-01&to=2026-02-01',
    '/communities/gardening/stats?window=7',
    '/communities/gardening/stats?x',
  ])('answers 400 for %s without querying', async (path) => {
    await get(path).expect(400);
    expect(statements).toHaveLength(0);
  });

  it('binds every aggregate to the resolved id, never the name', async () => {
    await get('/communities/gardening/stats').expect(200);

    expect(statements).toHaveLength(5);
    for (const { sql, values } of statements.slice(1)) {
      expect(values[0]).toBe('community-a');
      expect(values).not.toContain('gardening');
      expect(sql).not.toContain('gardening');
    }
  });

  it('carries counts only: no ids, usernames, emails or per-row data', async () => {
    for (const name of ['gardening', 'quiet']) {
      const response = await get(`/communities/${name}/stats`).expect(200);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toMatch(
        /@|user-|community-|"(id|creator_id|username|email|user_id)"/,
      );
      for (const [key, value] of Object.entries(
        response.body as Record<string, unknown>,
      )) {
        expect([key, typeof value === 'object' && value !== null]).toEqual([
          key,
          false,
        ]);
      }
    }
  });

  it('goes through the global API rate limiter as a read', async () => {
    await get('/communities/gardening/stats').expect(200);

    expect(rateLimited).toEqual([
      { method: 'GET', path: '/communities/gardening/stats' },
    ]);
  });
});
