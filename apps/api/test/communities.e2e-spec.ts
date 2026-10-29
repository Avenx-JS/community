import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';

interface TestCommunity {
  id: string;
  creator_id: string;
  name: string;
  description: string | null;
  created_at: Date;
}

// A database that has not yet run migration 014 still has the column. Every
// community row the fake returns carries it, so the tests prove the API never
// maps it into a response.
const staleRulesColumn = { rules: 'stale legacy rules' };

const tokenUsers: Record<string, string> = {
  'valid-token': 'authenticated-user',
  'other-token': 'user-b',
};

interface SubscriptionPage {
  items: Array<{
    community: { id: string; name: string; description: string | null };
    subscribed_at: string;
  }>;
  page: number;
  limit: number;
  total: number;
}

const communityIds = (body: unknown) =>
  (body as SubscriptionPage).items.map((item) => item.community.id);

describe('Community endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let communities: TestCommunity[];
  let subscriptions: Set<string>;
  let subscribedAt: Map<string, Date>;
  let preferences: Map<string, number>;
  let queryCalls: Array<{ sql: string; values: unknown[] }>;

  beforeEach(async () => {
    communities = [
      {
        id: 'community-a',
        creator_id: 'user-a',
        name: 'gardening',
        description: 'Growing plants',
        created_at: new Date('2026-10-20T12:00:00.000Z'),
      },
      {
        id: 'community-b',
        creator_id: 'user-b',
        name: 'garden-tools',
        description: 'Tools for gardening',
        created_at: new Date('2026-10-20T12:00:00.000Z'),
      },
      {
        id: 'community-c',
        creator_id: 'user-c',
        name: 'cooking',
        description: null,
        created_at: new Date('2026-10-19T12:00:00.000Z'),
      },
    ];
    subscriptions = new Set();
    subscribedAt = new Map();
    preferences = new Map();
    queryCalls = [];

    const pool = {
      execute: async (sql: string, values: unknown[]) => {
        queryCalls.push({ sql, values });

        if (sql.startsWith('INSERT INTO communities')) {
          expect(sql).not.toMatch(/\brules\b/);
          const [id, creatorId, name, description] = values as [
            string,
            string,
            string,
            string | null,
          ];
          if (communities.some((community) => community.name === name)) {
            throw Object.assign(new Error('Duplicate'), {
              code: 'ER_DUP_ENTRY',
            });
          }
          communities.push({
            id,
            creator_id: creatorId,
            name,
            description,
            created_at: new Date('2026-10-22T08:00:00.000Z'),
          });
          return [{ affectedRows: 1 }, []];
        }

        if (sql.startsWith('INSERT INTO community_subscriptions')) {
          const [userId, communityId] = values as [string, string];
          const key = `${userId}:${communityId}`;
          subscriptions.add(key);
          if (!subscribedAt.has(key)) {
            subscribedAt.set(key, new Date('2026-10-23T10:00:00.000Z'));
          }
          return [{ affectedRows: 1 }, []];
        }

        if (sql.startsWith('DELETE FROM community_subscriptions')) {
          const [userId, communityId] = values as [string, string];
          subscriptions.delete(`${userId}:${communityId}`);
          subscribedAt.delete(`${userId}:${communityId}`);
          return [{ affectedRows: 1 }, []];
        }

        if (sql.startsWith('INSERT INTO community_notification_preferences')) {
          const [userId, communityId, newPosts] = values as [
            string,
            string,
            boolean,
          ];
          preferences.set(`${userId}:${communityId}`, newPosts ? 1 : 0);
          return [{ affectedRows: 1 }, []];
        }

        if (
          sql.startsWith('SELECT c.id,') &&
          sql.includes('community_notification_preferences')
        ) {
          const [userId, , name] = values as [string, string, string];
          const community = communities.find((entry) => entry.name === name);
          if (!community) {
            return [[], []];
          }
          const key = `${userId}:${community.id}`;
          return [
            [
              {
                id: community.id,
                subscribed: subscriptions.has(key) ? 1 : 0,
                new_posts: preferences.get(key) ?? null,
              },
            ],
            [],
          ];
        }

        if (sql.includes('FROM community_subscriptions s')) {
          const [userId, limit, offset] = values as [string, number, number];
          // Rows carry extra columns so the tests prove the service maps
          // only the documented fields into the response.
          const rows = userSubscriptions(userId)
            .sort(
              (left, right) =>
                right.subscribed_at.getTime() - left.subscribed_at.getTime() ||
                right.id.localeCompare(left.id),
            )
            .map((row) => ({
              ...row,
              email: 'private@example.com',
              password_hash: 'private-hash',
            }));
          return [rows.slice(offset, offset + limit), []];
        }

        if (
          sql.startsWith(
            'SELECT COUNT(*) AS total FROM community_subscriptions',
          )
        ) {
          const [userId] = values as [string];
          return [[{ total: userSubscriptions(userId).length }], []];
        }

        if (sql.startsWith('SELECT created_at FROM community_subscriptions')) {
          const [userId, communityId] = values as [string, string];
          const createdAt = subscribedAt.get(`${userId}:${communityId}`);
          return [createdAt ? [{ created_at: createdAt }] : [], []];
        }

        if (sql.startsWith('SELECT COUNT(*) AS total')) {
          return [[{ total: filteredCommunities(sql, values).length }], []];
        }

        if (sql.includes('ORDER BY created_at DESC')) {
          const rows = filteredCommunities(sql, values).sort(
            (left, right) =>
              right.created_at.getTime() - left.created_at.getTime() ||
              right.id.localeCompare(left.id),
          );
          const limit = values[values.length - 2] as number;
          const offset = values[values.length - 1] as number;
          return [
            rows
              .slice(offset, offset + limit)
              .map((community) => ({ ...community, ...staleRulesColumn })),
            [],
          ];
        }

        if (sql.includes('WHERE id = ?')) {
          const [id] = values as [string];
          return [
            communities
              .filter((community) => community.id === id)
              .map((community) => ({ ...community, ...staleRulesColumn })),
            [],
          ];
        }

        if (sql.includes('WHERE name = ?')) {
          const [name] = values as [string];
          return [
            communities
              .filter((community) => community.name === name)
              .map((community) => ({ ...community, ...staleRulesColumn })),
            [],
          ];
        }

        throw new Error(`Unexpected SQL query: ${sql}`);
      },
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue(pool)
      .overrideProvider(AuthService)
      .useValue({
        validateAccessToken: async (token: string) => tokenUsers[token] ?? null,
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            tokenUsers[token]
              ? { kind: 'valid', userId: tokenUsers[token] }
              : { kind: 'invalid' },
          ),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    function userSubscriptions(userId: string) {
      return communities.flatMap((community) => {
        const createdAt = subscribedAt.get(`${userId}:${community.id}`);
        return createdAt ? [{ ...community, subscribed_at: createdAt }] : [];
      });
    }

    function filteredCommunities(
      sql: string,
      values: unknown[],
    ): TestCommunity[] {
      if (!sql.includes("ESCAPE '='")) {
        return communities;
      }
      const term = values[0] as string;
      const search = term.slice(1, -1).toLowerCase();
      return communities.filter(
        (community) =>
          community.name.toLowerCase().includes(search) ||
          (community.description?.toLowerCase().includes(search) ?? false),
      );
    }
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists communities in stable order and supports search and pagination', async () => {
    const firstPage = await request(app.getHttpServer())
      .get('/communities?search=GARDEN&page=1&limit=1')
      .expect(200);

    expect(firstPage.body).toMatchObject({
      page: 1,
      limit: 1,
      total: 2,
      items: [{ id: 'community-b', name: 'garden-tools' }],
    });

    const secondPage = await request(app.getHttpServer())
      .get('/communities?search=garden&page=2&limit=1')
      .expect(200);
    expect(secondPage.body.items).toMatchObject([
      { id: 'community-a', name: 'gardening' },
    ]);

    const emptyPage = await request(app.getHttpServer())
      .get('/communities?search=not-found')
      .expect(200);
    expect(emptyPage.body).toMatchObject({
      items: [],
      total: 0,
    });

    const injectionSearch = "' OR 1=1 --";
    await request(app.getHttpServer())
      .get(`/communities?search=${encodeURIComponent(injectionSearch)}`)
      .expect(200);
    expect(
      queryCalls.some((call) =>
        call.values.includes(`%${injectionSearch.replace(/[=%_]/g, '=$&')}%`),
      ),
    ).toBe(true);
    await request(app.getHttpServer())
      .get('/communities?page=1%20OR%201%3D1')
      .expect(400);
    await request(app.getHttpServer())
      .get('/communities?page=10001')
      .expect(400);
    await request(app.getHttpServer())
      .get('/communities?limit=101')
      .expect(400);
    await request(app.getHttpServer())
      .get('/communities?unexpected=value')
      .expect(400);
  });

  it('creates a community for the authenticated user and rejects duplicate names', async () => {
    const response = await request(app.getHttpServer())
      .post('/communities')
      .set('Authorization', 'Bearer valid-token')
      .send({
        name: '  board-games  ',
        description: 'Games and friends',
      })
      .expect(201);

    expect(response.body).toMatchObject({
      creator_id: 'authenticated-user',
      name: 'board-games',
      description: 'Games and friends',
    });
    expect(response.body).not.toHaveProperty('email');
    expect(response.body).not.toHaveProperty('password_hash');
    expect(queryCalls[0].values[1]).toBe('authenticated-user');

    await request(app.getHttpServer())
      .post('/communities')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: 'board-games' })
      .expect(409);
  });

  it('rejects invalid data and any caller-supplied creator field', async () => {
    const authorization = 'Bearer valid-token';

    await request(app.getHttpServer())
      .post('/communities')
      .set('Authorization', authorization)
      .send({ name: '' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/communities')
      .set('Authorization', authorization)
      .send({ name: 'x'.repeat(51) })
      .expect(400);
    await request(app.getHttpServer())
      .post('/communities')
      .set('Authorization', authorization)
      .send({ name: 'valid', description: 'x'.repeat(16384) })
      .expect(400);
    await request(app.getHttpServer())
      .post('/communities')
      .set('Authorization', authorization)
      .send({ name: 'attempt', creator_id: 'attacker' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/communities')
      .set('Authorization', authorization)
      .send({ name: "board' OR 1=1 --" })
      .expect(400);
  });

  it('rejects a legacy rules property with 400 and creates nothing', async () => {
    const before = communities.length;

    for (const rules of ['Have fun', '', null]) {
      const response = await request(app.getHttpServer())
        .post('/communities')
        .set('Authorization', 'Bearer valid-token')
        .send({ name: 'board-games', rules })
        .expect(400);
      expect((response.body as { message: string[] }).message).toEqual([
        'property rules should not exist',
      ]);
    }

    expect(communities).toHaveLength(before);
    expect(
      queryCalls.some((call) => call.sql.startsWith('INSERT INTO communities')),
    ).toBe(false);
  });

  it('returns no rules key from any community response', async () => {
    // Serialised bodies, so a reintroduced field fails regardless of where it
    // appears. The fake rows still carry a stale rules column.
    const created = await request(app.getHttpServer())
      .post('/communities')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: 'board-games' })
      .expect(201);
    const listed = await request(app.getHttpServer())
      .get('/communities?limit=100')
      .expect(200);
    const found = await request(app.getHttpServer())
      .get('/communities/garden-tools')
      .expect(200);

    expect((listed.body as { items: unknown[] }).items).toHaveLength(4);
    for (const response of [created, listed, found]) {
      expect(response.text).not.toMatch(/"rules"|stale legacy rules/);
    }
  });

  it('requires authentication to create and returns 404 for unknown names', async () => {
    await request(app.getHttpServer())
      .post('/communities')
      .send({ name: 'private' })
      .expect(401);

    const found = await request(app.getHttpServer())
      .get('/communities/gardening')
      .expect(200);
    expect(Object.keys(found.body).sort()).toEqual([
      'created_at',
      'creator_id',
      'description',
      'id',
      'name',
    ]);

    const response = await request(app.getHttpServer())
      .get('/communities/unknown')
      .expect(404);
    await request(app.getHttpServer())
      .get('/communities/board%27%20OR%201%3D1')
      .expect(400);
    expect(response.body).toMatchObject({
      statusCode: 404,
      message: 'Community not found',
      error: 'Not Found',
    });
  });

  it('subscribes idempotently and unsubscribes the authenticated user', async () => {
    const endpoint = '/communities/gardening/subscribe';

    await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', 'Bearer valid-token')
      .expect(204);
    expect(subscriptions).toEqual(new Set(['authenticated-user:community-a']));

    await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', 'Bearer valid-token')
      .expect(204);
    expect(subscriptions).toEqual(new Set(['authenticated-user:community-a']));
    expect(
      queryCalls.filter((call) =>
        call.sql.startsWith('INSERT INTO community_subscriptions'),
      ),
    ).toHaveLength(2);
    expect(
      queryCalls
        .filter((call) =>
          call.sql.startsWith('INSERT INTO community_subscriptions'),
        )
        .every((call) => call.sql.includes('ON DUPLICATE KEY UPDATE')),
    ).toBe(true);

    await request(app.getHttpServer())
      .delete(endpoint)
      .set('Authorization', 'Bearer valid-token')
      .expect(204);
    expect(subscriptions.size).toBe(0);

    await request(app.getHttpServer())
      .delete(endpoint)
      .set('Authorization', 'Bearer valid-token')
      .expect(204);
    expect(subscriptions.size).toBe(0);
  });

  it('requires authentication and returns 404 for unknown subscription targets', async () => {
    await request(app.getHttpServer())
      .post('/communities/gardening/subscribe')
      .expect(401);
    await request(app.getHttpServer())
      .delete('/communities/gardening/subscribe')
      .expect(401);

    const subscribe = await request(app.getHttpServer())
      .post('/communities/unknown/subscribe')
      .set('Authorization', 'Bearer valid-token')
      .expect(404);
    expect(subscribe.body.message).toBe('Community not found');

    const unsubscribe = await request(app.getHttpServer())
      .delete('/communities/unknown/subscribe')
      .set('Authorization', 'Bearer valid-token')
      .expect(404);
    expect(unsubscribe.body.message).toBe('Community not found');
  });

  function seedSubscription(userId: string, communityId: string, at: string) {
    subscriptions.add(`${userId}:${communityId}`);
    subscribedAt.set(`${userId}:${communityId}`, new Date(at));
  }

  function expectNoPrivateFields(body: unknown) {
    expect(JSON.stringify(body)).not.toMatch(
      /email|password|hash|token|session|creator_id|rules/i,
    );
  }

  it('requires authentication and validates the subscription listing query', async () => {
    await request(app.getHttpServer()).get('/subscriptions').expect(401);
    await request(app.getHttpServer())
      .get('/subscriptions')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);

    for (const query of [
      'page=0',
      'page=10001',
      'page=1.5',
      'page=1%20OR%201%3D1',
      'limit=0',
      'limit=101',
      'user_id=user-b',
      'unexpected=value',
    ]) {
      await request(app.getHttpServer())
        .get(`/subscriptions?${query}`)
        .set('Authorization', 'Bearer valid-token')
        .expect(400);
    }
    expect(
      queryCalls.some((call) => call.sql.includes('community_subscriptions')),
    ).toBe(false);
  });

  it('returns an empty subscription page for an account with none', async () => {
    const response = await request(app.getHttpServer())
      .get('/subscriptions')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(response.body).toEqual({ items: [], page: 1, limit: 20, total: 0 });
  });

  it('pages through the user subscriptions newest first, each exactly once', async () => {
    seedSubscription(
      'authenticated-user',
      'community-a',
      '2026-10-22T10:00:00.000Z',
    );
    seedSubscription(
      'authenticated-user',
      'community-b',
      '2026-10-22T10:00:00.000Z',
    );
    seedSubscription(
      'authenticated-user',
      'community-c',
      '2026-10-21T10:00:00.000Z',
    );

    const seen: string[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const response = await request(app.getHttpServer())
        .get(`/subscriptions?page=${page}&limit=1`)
        .set('Authorization', 'Bearer valid-token')
        .expect(200);
      expect(response.body).toMatchObject({ page, limit: 1, total: 3 });
      expectNoPrivateFields(response.body);
      seen.push(...communityIds(response.body));
    }

    expect(seen).toEqual(['community-b', 'community-a', 'community-c']);

    const all = await request(app.getHttpServer())
      .get('/subscriptions')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);
    expect((all.body as SubscriptionPage).items[0]).toEqual({
      community: {
        id: 'community-b',
        name: 'garden-tools',
        description: 'Tools for gardening',
      },
      subscribed_at: '2026-10-22T10:00:00.000Z',
    });
  });

  it('never returns another account subscriptions', async () => {
    seedSubscription(
      'authenticated-user',
      'community-a',
      '2026-10-22T10:00:00.000Z',
    );
    seedSubscription('user-b', 'community-c', '2026-10-22T11:00:00.000Z');

    const own = await request(app.getHttpServer())
      .get('/subscriptions')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);
    const other = await request(app.getHttpServer())
      .get('/subscriptions')
      .set('Authorization', 'Bearer other-token')
      .expect(200);

    expect(communityIds(own.body)).toEqual(['community-a']);
    expect(communityIds(other.body)).toEqual(['community-c']);
    expect((own.body as SubscriptionPage).total).toBe(1);
    expect(
      queryCalls
        .filter((call) => call.sql.includes('community_subscriptions'))
        .map((call) => call.values[0]),
    ).toEqual(['authenticated-user', 'authenticated-user', 'user-b', 'user-b']);
  });

  it('reports the authenticated user subscription to one community', async () => {
    const endpoint = '/communities/gardening/subscription';

    await request(app.getHttpServer()).get(endpoint).expect(401);

    const before = await request(app.getHttpServer())
      .get(endpoint)
      .set('Authorization', 'Bearer valid-token')
      .expect(200);
    expect(before.body).toEqual({ subscribed: false, subscribed_at: null });

    await request(app.getHttpServer())
      .post('/communities/gardening/subscribe')
      .set('Authorization', 'Bearer valid-token')
      .expect(204);

    const after = await request(app.getHttpServer())
      .get(endpoint)
      .set('Authorization', 'Bearer valid-token')
      .expect(200);
    expect(after.body).toEqual({
      subscribed: true,
      subscribed_at: '2026-10-23T10:00:00.000Z',
    });
    expectNoPrivateFields(after.body);

    const otherUser = await request(app.getHttpServer())
      .get(endpoint)
      .set('Authorization', 'Bearer other-token')
      .expect(200);
    expect(otherUser.body).toEqual({ subscribed: false, subscribed_at: null });

    const unknown = await request(app.getHttpServer())
      .get('/communities/unknown/subscription')
      .set('Authorization', 'Bearer valid-token')
      .expect(404);
    expect((unknown.body as { message: string }).message).toBe(
      'Community not found',
    );

    await request(app.getHttpServer())
      .get('/communities/board%27%20OR%201%3D1/subscription')
      .set('Authorization', 'Bearer valid-token')
      .expect(400);
  });

  describe('notification preferences', () => {
    const endpoint = '/communities/gardening/notification-preferences';

    it('requires authentication and validates the community name', async () => {
      await request(app.getHttpServer()).get(endpoint).expect(401);
      await request(app.getHttpServer())
        .put(endpoint)
        .send({ new_posts: false })
        .expect(401);

      for (const method of ['get', 'put'] as const) {
        const unknown = await request(app.getHttpServer())
          [method]('/communities/unknown/notification-preferences')
          .set('Authorization', 'Bearer valid-token')
          .send({ new_posts: false })
          .expect(404);
        expect((unknown.body as { message: string }).message).toBe(
          'Community not found',
        );
        await request(app.getHttpServer())
          [method](
            '/communities/board%27%20OR%201%3D1/notification-preferences',
          )
          .set('Authorization', 'Bearer valid-token')
          .send({ new_posts: false })
          .expect(400);
      }
      expect(preferences.size).toBe(0);
    });

    it('reports defaults and membership without a stored preference', async () => {
      const outsider = await request(app.getHttpServer())
        .get(endpoint)
        .set('Authorization', 'Bearer valid-token')
        .expect(200);
      expect(outsider.body).toEqual({ new_posts: true, subscribed: false });

      seedSubscription(
        'authenticated-user',
        'community-a',
        '2026-10-22T10:00:00.000Z',
      );
      const member = await request(app.getHttpServer())
        .get(endpoint)
        .set('Authorization', 'Bearer valid-token')
        .expect(200);
      expect(member.body).toEqual({ new_posts: true, subscribed: true });
      expect(preferences.size).toBe(0);
    });

    it('stores a preference idempotently, also for a non-member', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await request(app.getHttpServer())
          .put(endpoint)
          .set('Authorization', 'Bearer valid-token')
          .send({ new_posts: false })
          .expect(200);
        expect(response.body).toEqual({ new_posts: false, subscribed: false });
      }
      expect([...preferences]).toEqual([['authenticated-user:community-a', 0]]);

      const stored = await request(app.getHttpServer())
        .get(endpoint)
        .set('Authorization', 'Bearer valid-token')
        .expect(200);
      expect(stored.body).toEqual({ new_posts: false, subscribed: false });
    });

    it('rejects invalid bodies without writing', async () => {
      for (const body of [
        {},
        { new_posts: 'false' },
        { new_posts: null },
        { new_posts: false, user_id: 'user-b' },
        { new_posts: false, unexpected: true },
      ]) {
        await request(app.getHttpServer())
          .put(endpoint)
          .set('Authorization', 'Bearer valid-token')
          .send(body)
          .expect(400);
      }
      expect(preferences.size).toBe(0);
      expect(
        queryCalls.some((call) =>
          call.sql.includes('community_notification_preferences'),
        ),
      ).toBe(false);
    });

    it('keeps each account preference separate', async () => {
      await request(app.getHttpServer())
        .put(endpoint)
        .set('Authorization', 'Bearer valid-token')
        .send({ new_posts: false })
        .expect(200);

      const other = await request(app.getHttpServer())
        .get(endpoint)
        .set('Authorization', 'Bearer other-token')
        .expect(200);
      expect(other.body).toEqual({ new_posts: true, subscribed: false });

      await request(app.getHttpServer())
        .put(endpoint)
        .set('Authorization', 'Bearer other-token')
        .send({ new_posts: true })
        .expect(200);

      const own = await request(app.getHttpServer())
        .get(endpoint)
        .set('Authorization', 'Bearer valid-token')
        .expect(200);
      expect(own.body).toEqual({ new_posts: false, subscribed: false });
      expect(Object.fromEntries(preferences)).toEqual({
        'authenticated-user:community-a': 0,
        'user-b:community-a': 1,
      });
      expect(
        queryCalls
          .filter((call) =>
            call.sql.startsWith(
              'INSERT INTO community_notification_preferences',
            ),
          )
          .map((call) => call.values[0]),
      ).toEqual(['authenticated-user', 'user-b']);
    });
  });
});
