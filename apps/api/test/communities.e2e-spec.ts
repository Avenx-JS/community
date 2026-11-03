import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { CommunityRuleAcceptanceService } from '../src/communities/community-rule-acceptance.service';
import {
  createRulesStore,
  type RulesStore,
} from './fakes/community-rules-store';

interface TestCommunity {
  id: string;
  creator_id: string;
  name: string;
  description: string | null;
  created_at: Date;
  deleted_at?: Date | null;
  deleted_by?: string | null;
}

interface LogEntry {
  community_id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata: string | null;
}

// A database that has not yet run migration 014 still has the column. Every
// community row the fake returns carries it, so the tests prove the API never
// maps it into a response.
const staleRulesColumn = { rules: 'stale legacy rules' };

const tokenUsers: Record<string, string> = {
  'valid-token': 'authenticated-user',
  'other-token': 'user-b',
  // user-a created "gardening"; user-m moderates it.
  'creator-token': 'user-a',
  'moderator-token': 'user-m',
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
  let rules: RulesStore;
  let logEntries: LogEntry[];
  let failLogInsert: boolean;
  let transactions: { committed: number; rolledBack: number };

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
    // No community has published rules unless a test publishes some.
    rules = createRulesStore(
      Object.fromEntries(
        communities.map((community) => [
          community.id,
          { name: community.name, creator_id: community.creator_id },
        ]),
      ),
    );

    logEntries = [];
    failLogInsert = false;
    transactions = { committed: 0, rolledBack: 0 };

    const isDeleted = (value: unknown) =>
      communities.some(
        (community) =>
          community.deleted_at &&
          (community.name === value || community.id === value),
      );

    const pool = {
      execute: async (sql: string, values: unknown[]) => {
        queryCalls.push({ sql, values });

        // Soft deletion: a single-community lookup that excludes deleted
        // communities finds nothing for one. A lookup without the exclusion
        // still finds it, so a read path that forgets it fails its test.
        if (
          sql.includes('FROM communities') &&
          sql.includes('deleted_at IS NULL') &&
          /\b(?:name|id) = \?/.test(sql) &&
          values.some(isDeleted)
        ) {
          return [[], []];
        }

        const ruleAnswer = rules.handle(sql, values);
        if (ruleAnswer) {
          return ruleAnswer;
        }

        if (sql === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
          return [[{ username: String(values[0]).replace('-', '_') }], []];
        }

        if (sql.includes('INSERT INTO community_moderation_actions')) {
          if (failLogInsert) {
            throw new Error('Log insert failed');
          }
          const [, communityId, actorId, , action, targetType, targetId] =
            values as string[];
          logEntries.push({
            community_id: communityId,
            actor_id: actorId,
            action,
            target_type: targetType,
            target_id: targetId,
            metadata: values[7] as string | null,
          });
          return [{ affectedRows: 1 }, []];
        }

        if (sql === 'UPDATE communities SET description = ? WHERE id = ?') {
          const [description, id] = values as [string | null, string];
          const community = communities.find((entry) => entry.id === id);
          if (community) community.description = description;
          return [{ affectedRows: community ? 1 : 0 }, []];
        }

        if (
          sql ===
          'UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE id = ?'
        ) {
          const [actorId, id] = values as [string, string];
          const community = communities.find((entry) => entry.id === id);
          if (community) {
            community.deleted_at = new Date('2026-11-03T12:00:00.000Z');
            community.deleted_by = actorId;
          }
          return [{ affectedRows: community ? 1 : 0 }, []];
        }

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

        if (
          sql.includes('FROM community_subscriptions s') &&
          !sql.startsWith('SELECT COUNT(*)')
        ) {
          const [userId, limit, offset] = values as [string, number, number];
          // Rows carry extra columns so the tests prove the service maps
          // only the documented fields into the response.
          const rows = userSubscriptions(userId, sql)
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
          sql.startsWith('SELECT COUNT(*) AS total') &&
          sql.includes('FROM community_subscriptions')
        ) {
          const [userId] = values as [string];
          return [[{ total: userSubscriptions(userId, sql).length }], []];
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
      // A transaction snapshots the mutable state and restores it on
      // rollback, so a failed log write is seen to undo the change.
      getConnection: () => {
        let snapshot: {
          communities: TestCommunity[];
          logEntries: LogEntry[];
        } | null = null;
        return Promise.resolve({
          execute: (sql: string, values: unknown[]) =>
            pool.execute(sql, values),
          beginTransaction: () => {
            snapshot = structuredClone({ communities, logEntries });
            return Promise.resolve();
          },
          commit: () => {
            snapshot = null;
            transactions.committed += 1;
            return Promise.resolve();
          },
          rollback: () => {
            if (snapshot) {
              communities.splice(
                0,
                communities.length,
                ...snapshot.communities,
              );
              logEntries.splice(0, logEntries.length, ...snapshot.logEntries);
            }
            snapshot = null;
            transactions.rolledBack += 1;
            return Promise.resolve();
          },
          release: () => undefined,
        });
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

    function userSubscriptions(userId: string, sql: string) {
      const live = sql.includes('c.deleted_at IS NULL');
      return communities.flatMap((community) => {
        if (live && community.deleted_at) {
          return [];
        }
        const createdAt = subscribedAt.get(`${userId}:${community.id}`);
        return createdAt ? [{ ...community, subscribed_at: createdAt }] : [];
      });
    }

    function filteredCommunities(
      sql: string,
      values: unknown[],
    ): TestCommunity[] {
      const visible = sql.includes('deleted_at IS NULL')
        ? communities.filter((community) => !community.deleted_at)
        : communities;
      if (!sql.includes("ESCAPE '='")) {
        return visible;
      }
      const term = values[0] as string;
      const search = term.slice(1, -1).toLowerCase();
      return visible.filter(
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

  describe('rule acceptance', () => {
    const as = (token: string) => ({
      post: (path: string) =>
        request(app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${token}`),
      get: (path: string) =>
        request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${token}`),
      delete: (path: string) =>
        request(app.getHttpServer())
          .delete(path)
          .set('Authorization', `Bearer ${token}`),
    });
    const member = as('valid-token');
    const subscribePath = '/communities/gardening/subscribe';

    it('refuses to join until the rules are accepted, then joins', async () => {
      rules.publish('community-a');

      const refused = await member.post(subscribePath).expect(403);
      expect(refused.body).toEqual({
        reason: 'community_rules_not_accepted',
        community: 'gardening',
        current_version: 1,
      });
      expect(JSON.stringify(refused.body)).not.toMatch(
        /authenticated-user|community-a|rules-v|user-a/,
      );
      expect(subscriptions.size).toBe(0);

      await member
        .post('/communities/gardening/rules/acceptance')
        .send({ version: 1 })
        .expect(201);
      await member.post(subscribePath).expect(204);
      expect(subscriptions).toEqual(
        new Set(['authenticated-user:community-a']),
      );
    });

    it('lets a member who has not accepted new rules leave and read', async () => {
      await member.post(subscribePath).expect(204);
      rules.publish('community-a');
      const check = jest.spyOn(
        app.get(CommunityRuleAcceptanceService),
        'assertAcceptedOrThrow',
      );

      await member.get('/communities/gardening').expect(200);
      await member.get('/communities').expect(200);
      await member.get('/communities/gardening/rules/acceptance').expect(200);
      await member.delete(subscribePath).expect(204);

      expect(subscriptions.size).toBe(0);
      expect(check).not.toHaveBeenCalled();
    });

    it('never refuses the community creator', async () => {
      rules.publish('community-b');

      await as('other-token')
        .post('/communities/garden-tools/subscribe')
        .expect(204);
    });

    it('returns 404, not 403, for an unknown community', async () => {
      rules.publish('community-a');

      await member.post('/communities/unknown/subscribe').expect(404);
    });
  });

  describe('editing and deleting a community', () => {
    const send = (
      method: 'get' | 'post' | 'put' | 'patch' | 'delete',
      path: string,
      token?: string,
      body?: object,
    ) => {
      const call = request(app.getHttpServer())[method](path);
      if (token) call.set('Authorization', `Bearer ${token}`);
      return body === undefined ? call : call.send(body);
    };
    const gardening = () =>
      communities.find((community) => community.id === 'community-a')!;
    const writes = () =>
      queryCalls.filter(({ sql }) => /^\s*(UPDATE|DELETE|INSERT)\b/.test(sql));

    it('lets the creator edit the description and leaves the name unchanged', async () => {
      const response = await send(
        'patch',
        '/communities/gardening',
        'creator-token',
        { description: '  Growing plants, fixed  ' },
      ).expect(200);

      expect(response.body).toEqual({
        id: 'community-a',
        creator_id: 'user-a',
        name: 'gardening',
        description: 'Growing plants, fixed',
        created_at: '2026-10-20T12:00:00.000Z',
      });
      expect(gardening().name).toBe('gardening');
      expect(logEntries).toEqual([
        {
          community_id: 'community-a',
          actor_id: 'user-a',
          action: 'community_updated',
          target_type: 'community',
          target_id: 'community-a',
          metadata: '{"fields":"description"}',
        },
      ]);
      expect(transactions.committed).toBe(1);
    });

    it('stores a whitespace-only description as NULL', async () => {
      const response = await send(
        'patch',
        '/communities/gardening',
        'creator-token',
        { description: ' \n\t ' },
      ).expect(200);

      expect(
        (response.body as { description: string | null }).description,
      ).toBeNull();
      expect(gardening().description).toBeNull();
    });

    it.each([
      [{}],
      [{ name: 'renamed' }],
      [{ description: 'ok', name: 'renamed' }],
      [{ rules: 'Be kind' }],
      [{ description: 'ok', rules: [{ title: 'Be kind' }] }],
      [{ description: 'ok', creator_id: 'user-b' }],
      [{ description: 'ok', unknown: true }],
      [{ description: 'x'.repeat(16384) }],
      [{ description: 'bell\u0007' }],
      [{ description: null }],
    ])('rejects the edit %o with 400 and writes nothing', async (body) => {
      await send(
        'patch',
        '/communities/gardening',
        'creator-token',
        body,
      ).expect(400);
      expect(writes()).toEqual([]);
      expect(gardening()).toMatchObject({
        name: 'gardening',
        description: 'Growing plants',
      });
    });

    it.each([
      ['patch', { description: 'Hijacked' }],
      ['delete', { name: 'gardening' }],
    ] as const)(
      '%s answers 401, 400, 404 and 403 in that order of precedence',
      async (method, body) => {
        await send(method, '/communities/gardening', undefined, body).expect(
          401,
        );
        await send(
          method,
          '/communities/bad.name',
          'creator-token',
          body,
        ).expect(400);
        await send(
          method,
          '/communities/unknown',
          'moderator-token',
          method === 'delete' ? { name: 'unknown' } : body,
        ).expect(404);
        for (const token of ['moderator-token', 'other-token', 'valid-token']) {
          const refused = await send(
            method,
            '/communities/gardening',
            token,
            body,
          ).expect(403);
          expect((refused.body as { message: string }).message).toMatch(
            /Only the community creator/,
          );
        }

        expect(writes()).toEqual([]);
        expect(gardening().description).toBe('Growing plants');
        expect(gardening().deleted_at).toBeUndefined();
      },
    );

    it('soft-deletes for the creator with a matching confirmation and destroys nothing', async () => {
      await send(
        'post',
        '/communities/gardening/subscribe',
        'valid-token',
      ).expect(204);
      await send(
        'put',
        '/communities/gardening/notification-preferences',
        'valid-token',
        { new_posts: false },
      ).expect(200);
      rules.publish('community-a');
      const subscriptionsBefore = new Set(subscriptions);
      const preferencesBefore = new Map(preferences);
      const documentsBefore = JSON.stringify(rules.documents);
      const acceptancesBefore = JSON.stringify(rules.acceptances);
      queryCalls = [];

      await send('delete', '/communities/gardening', 'creator-token', {
        name: 'gardening',
      }).expect(204);

      expect(gardening()).toMatchObject({
        deleted_at: expect.any(Date),
        deleted_by: 'user-a',
      });
      expect(logEntries).toEqual([
        {
          community_id: 'community-a',
          actor_id: 'user-a',
          action: 'community_deleted',
          target_type: 'community',
          target_id: 'community-a',
          metadata: null,
        },
      ]);
      expect(queryCalls.some(({ sql }) => /^\s*DELETE\b/i.test(sql))).toBe(
        false,
      );
      expect(communities).toHaveLength(3);
      expect(subscriptions).toEqual(subscriptionsBefore);
      expect(preferences).toEqual(preferencesBefore);
      expect(JSON.stringify(rules.documents)).toBe(documentsBefore);
      expect(JSON.stringify(rules.acceptances)).toBe(acceptancesBefore);
    });

    it.each([
      [{ name: 'garden' }],
      [{ name: 'Gardening' }],
      [{ name: ' gardening' }],
      [{}],
      [undefined],
      [{ name: 'gardening', force: true }],
    ])(
      'refuses the confirmation %o with 400 and deletes nothing',
      async (body) => {
        await send(
          'delete',
          '/communities/gardening',
          'creator-token',
          body,
        ).expect(400);
        expect(writes()).toEqual([]);
        expect(gardening().deleted_at).toBeUndefined();
      },
    );

    it('answers 404 to deleting an already-deleted community', async () => {
      await send('delete', '/communities/gardening', 'creator-token', {
        name: 'gardening',
      }).expect(204);
      queryCalls = [];

      await send('delete', '/communities/gardening', 'creator-token', {
        name: 'gardening',
      }).expect(404);
      expect(writes()).toEqual([]);
      expect(logEntries).toHaveLength(1);
    });

    it.each([
      ['patch', { description: 'Changed' }],
      ['delete', { name: 'gardening' }],
    ] as const)(
      'rolls the %s back when its log entry cannot be written',
      async (method, body) => {
        failLogInsert = true;

        await send(
          method,
          '/communities/gardening',
          'creator-token',
          body,
        ).expect(500);

        expect(transactions).toEqual({ committed: 0, rolledBack: 1 });
        expect(gardening()).toMatchObject({ description: 'Growing plants' });
        expect(gardening().deleted_at).toBeUndefined();
        expect(logEntries).toEqual([]);
      },
    );

    it('hides a deleted community from every read and refuses every write to it', async () => {
      await send(
        'post',
        '/communities/gardening/subscribe',
        'valid-token',
      ).expect(204);
      await send(
        'post',
        '/communities/cooking/subscribe',
        'valid-token',
      ).expect(204);
      rules.publish('community-a');
      await send('delete', '/communities/gardening', 'creator-token', {
        name: 'gardening',
      }).expect(204);

      const listed = await send('get', '/communities?limit=100').expect(200);
      const listedBody = listed.body as {
        items: { id: string }[];
        total: number;
      };
      expect(listedBody.items.map((item) => item.id)).toEqual([
        'community-b',
        'community-c',
      ]);
      expect(listedBody.total).toBe(2);

      const searched = await send('get', '/communities?search=garden').expect(
        200,
      );
      expect(searched.body).toMatchObject({
        total: 1,
        items: [{ id: 'community-b' }],
      });

      const subscribed = await send(
        'get',
        '/subscriptions',
        'valid-token',
      ).expect(200);
      expect(communityIds(subscribed.body)).toEqual(['community-c']);
      expect((subscribed.body as SubscriptionPage).total).toBe(1);

      const gone: Array<
        [Parameters<typeof send>[0], string, string | undefined, object?]
      > = [
        ['get', '/communities/gardening', undefined],
        [
          'patch',
          '/communities/gardening',
          'creator-token',
          { description: 'x' },
        ],
        [
          'delete',
          '/communities/gardening',
          'creator-token',
          { name: 'gardening' },
        ],
        ['get', '/communities/gardening/subscription', 'valid-token'],
        ['post', '/communities/gardening/subscribe', 'valid-token'],
        ['delete', '/communities/gardening/subscribe', 'valid-token'],
        [
          'get',
          '/communities/gardening/notification-preferences',
          'valid-token',
        ],
        [
          'put',
          '/communities/gardening/notification-preferences',
          'valid-token',
          { new_posts: true },
        ],
        [
          'post',
          '/communities/gardening/moderators',
          'creator-token',
          { username: 'member' },
        ],
        [
          'delete',
          '/communities/gardening/moderators',
          'creator-token',
          { username: 'member' },
        ],
        ['get', '/communities/gardening/rules', undefined],
        [
          'put',
          '/communities/gardening/rules',
          'creator-token',
          { items: [{ title: 'Be kind' }] },
        ],
        ['get', '/communities/gardening/rules/versions', undefined],
        ['get', '/communities/gardening/rules/versions/1', undefined],
        ['get', '/communities/gardening/rules/acceptance', 'valid-token'],
        [
          'post',
          '/communities/gardening/rules/acceptance',
          'valid-token',
          { version: 1 },
        ],
        ['get', '/communities/gardening/moderation-log', 'creator-token'],
      ];
      queryCalls = [];
      for (const [method, path, token, body] of gone) {
        const response = await send(method, path, token, body);
        expect([method, path, response.status]).toEqual([method, path, 404]);
      }
      expect(writes()).toEqual([]);

      // The name stays taken: names are never reused.
      await send('post', '/communities', 'valid-token', {
        name: 'gardening',
      }).expect(409);
    });
  });
});
