import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { MYSQL_POOL } from '../src/auth/auth.service';
import { ApiRateLimitInterceptor } from '../src/common/api-rate-limit.interceptor';
import { LISTED_COMMUNITY_ID_SQL } from '../src/communities/communities.service';
import { answerVoteScores } from './fakes/vote-scores';

interface TestCommunity {
  id: string;
  name: string;
  deleted_at?: Date;
  suspended_at?: Date;
}

interface TestPost {
  id: string;
  title: string;
  content: string;
  type: 'text';
  author_id: string;
  community_id: string;
  created_at: Date;
  pinned_at: Date | null;
  pinned_by: string | null;
  removed_at?: Date;
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 8, minute));

describe('GET /communities/:name/posts (e2e)', () => {
  let app: INestApplication<App>;
  let communities: TestCommunity[];
  let posts: TestPost[];
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let rateLimitCalls: Array<{ method: string; path: string }>;
  let rateLimited: Set<string>;

  const get = (path: string) => request(app.getHttpServer()).get(path);
  const post = (
    id: string,
    communityId: string,
    minute: number,
    extra: Partial<TestPost> = {},
  ): TestPost => ({
    id,
    title: `Title ${id}`,
    content: 'Body',
    type: 'text',
    author_id: 'author',
    community_id: communityId,
    created_at: at(minute),
    pinned_at: null,
    pinned_by: null,
    ...extra,
  });

  beforeEach(async () => {
    queryCalls = [];
    rateLimitCalls = [];
    rateLimited = new Set();
    communities = [
      { id: 'community-1', name: 'general' },
      { id: 'community-2', name: 'other' },
      { id: 'community-empty', name: 'quiet' },
      { id: 'community-deleted', name: 'gone', deleted_at: at(0) },
      { id: 'community-suspended', name: 'paused', suspended_at: at(0) },
    ];
    posts = [
      post('p1', 'community-1', 1),
      post('p2', 'community-1', 2),
      post('p3', 'community-1', 2),
      post('p4', 'community-1', 3, {
        pinned_at: at(30),
        pinned_by: 'moderator',
      }),
      post('p5', 'community-1', 4, { removed_at: at(40) }),
      post('p-other', 'community-2', 5),
      post('p-deleted', 'community-deleted', 6),
      post('p-suspended', 'community-suspended', 7),
    ];

    // Evaluates exactly the statements the services issue: the name lookup
    // and the shared post listing with its count.
    const live = (communityId: string, sql: string) => {
      const community = communities.find((entry) => entry.id === communityId);
      return (
        !!community &&
        !(sql.includes('deleted_at IS NULL') && community.deleted_at)
      );
    };
    const visible = (sql: string, values: unknown[]) =>
      posts.filter(
        (entry) =>
          live(entry.community_id, sql) &&
          !(sql.includes('posts.removed_at IS NULL') && entry.removed_at) &&
          (!sql.includes('WHERE community_id = ?') ||
            entry.community_id === values[0]),
      );
    const execute = (sql: string, values: unknown[]) => {
      queryCalls.push({ sql, values });
      const scoreAnswer = answerVoteScores(sql, values);
      if (scoreAnswer) {
        return Promise.resolve(scoreAnswer);
      }
      if (sql === LISTED_COMMUNITY_ID_SQL) {
        const community = communities.find(
          (entry) =>
            entry.name === values[0] &&
            !entry.deleted_at &&
            !entry.suspended_at,
        );
        return Promise.resolve([community ? [{ id: community.id }] : [], []]);
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM posts')) {
        return Promise.resolve([[{ total: visible(sql, values).length }], []]);
      }
      if (sql.startsWith('SELECT id, title, content, type')) {
        const floats = sql.includes('ORDER BY (pinned_at IS NULL)');
        const rows = visible(sql, values).sort(
          (left, right) =>
            (floats
              ? Number(!left.pinned_at) - Number(!right.pinned_at) ||
                (right.pinned_at?.getTime() ?? 0) -
                  (left.pinned_at?.getTime() ?? 0)
              : 0) ||
            right.created_at.getTime() - left.created_at.getTime() ||
            right.id.localeCompare(left.id),
        );
        const [limit, offset] = values.slice(-2) as [number, number];
        return Promise.resolve([rows.slice(offset, offset + limit), []]);
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
          rateLimitCalls.push({ method, path });
          return Promise.resolve(
            rateLimited.has(`${method} ${path}`) ? 60 : null,
          );
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
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

  it('returns 200 without a token, pins first, removed posts omitted', async () => {
    const response = await get('/communities/general/posts').expect(200);

    expect(response.body).toMatchObject({
      page: 1,
      limit: 20,
      total: 4,
      sort: 'new',
    });
    const body = response.body as { items: Record<string, unknown>[] };
    expect(body.items.map((item) => item.id)).toEqual(['p4', 'p3', 'p2', 'p1']);
    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        'author_id',
        'community_id',
        'content',
        'created_at',
        'id',
        'pinned_at',
        'pinned_by',
        'edited_at',
        'locked_at',
        'locked_by',
        'score',
        'title',
        'type',
      ].sort(),
    );
  });

  it.each([
    '',
    '?page=1&limit=2',
    '?page=2&limit=2',
    '?page=3&limit=2',
    '?limit=1&page=4',
    '?sort=new',
  ])('answers exactly as GET /posts?community_id= does (%s)', async (query) => {
    const byName = await get(`/communities/general/posts${query}`).expect(200);
    const separator = query ? '&' : '?';
    const byId = await get(
      `/posts${query}${separator}community_id=community-1`,
    ).expect(200);

    expect(byName.body).toEqual(byId.body);
  });

  it('pages each post exactly once with the id tiebreaker', async () => {
    const seen: string[] = [];
    for (const page of [1, 2, 3, 4, 5]) {
      const response = await get(
        `/communities/general/posts?page=${page}&limit=1`,
      ).expect(200);
      const body = response.body as { items: { id: string }[]; total: number };
      expect(body.total).toBe(4);
      seen.push(...body.items.map((item) => item.id));
    }
    expect(seen).toEqual(['p4', 'p3', 'p2', 'p1']);
  });

  it('answers a community with no posts with an empty page', async () => {
    await expect(
      get('/communities/quiet/posts')
        .expect(200)
        .then((response) => response.body as unknown),
    ).resolves.toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      sort: 'new',
    });
  });

  it.each(['unknown', 'gone', 'paused'])(
    'answers %s with 404 and lists nothing',
    async (name) => {
      const response = await get(`/communities/${name}/posts`).expect(404);
      expect(response.body).toMatchObject({ message: 'Community not found' });
      expect(queryCalls.map(({ sql }) => sql)).toEqual([
        LISTED_COMMUNITY_ID_SQL,
      ]);
    },
  );

  it.each([
    '/communities/general%27%20OR%201%3D1/posts',
    `/communities/${'a'.repeat(51)}/posts`,
    '/communities/general/posts?community_id=community-2',
    '/communities/general/posts?unexpected=value',
    '/communities/general/posts?page=0',
    '/communities/general/posts?page=10001',
    '/communities/general/posts?page=1.5',
    '/communities/general/posts?limit=0',
    '/communities/general/posts?limit=101',
    '/communities/general/posts?sort=oldest',
  ])('rejects %s with 400 before querying', async (path) => {
    await get(path).expect(400);
    expect(queryCalls).toEqual([]);
  });

  it('keeps GET /posts and its community filter unchanged', async () => {
    const all = await get('/posts?limit=100').expect(200);
    const allBody = all.body as { items: { id: string }[]; total: number };
    // The global feed is newest first and floats no pins.
    expect(allBody.items.map((item) => item.id)).toEqual([
      'p-suspended',
      'p-other',
      'p4',
      'p3',
      'p2',
      'p1',
    ]);
    expect(allBody.total).toBe(6);
  });

  it('stays behind the global read rate limit', async () => {
    await get('/communities/general/posts').expect(200);
    expect(rateLimitCalls).toEqual([
      { method: 'GET', path: '/communities/general/posts' },
    ]);

    rateLimited.add('GET /communities/general/posts');
    queryCalls = [];
    await get('/communities/general/posts').expect(429);
    expect(queryCalls).toEqual([]);
  });
});
