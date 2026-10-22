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
  rules: string | null;
  created_at: Date;
}

describe('Community endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let communities: TestCommunity[];
  let subscriptions: Set<string>;
  let queryCalls: Array<{ sql: string; values: unknown[] }>;

  beforeEach(async () => {
    communities = [
      {
        id: 'community-a',
        creator_id: 'user-a',
        name: 'gardening',
        description: 'Growing plants',
        rules: null,
        created_at: new Date('2026-10-20T12:00:00.000Z'),
      },
      {
        id: 'community-b',
        creator_id: 'user-b',
        name: 'garden-tools',
        description: 'Tools for gardening',
        rules: 'Be kind',
        created_at: new Date('2026-10-20T12:00:00.000Z'),
      },
      {
        id: 'community-c',
        creator_id: 'user-c',
        name: 'cooking',
        description: null,
        rules: null,
        created_at: new Date('2026-10-19T12:00:00.000Z'),
      },
    ];
    subscriptions = new Set();
    queryCalls = [];

    const pool = {
      execute: async (sql: string, values: unknown[]) => {
        queryCalls.push({ sql, values });

        if (sql.startsWith('INSERT INTO communities')) {
          const [id, creatorId, name, description, rules] = values as [
            string,
            string,
            string,
            string | null,
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
            rules,
            created_at: new Date('2026-10-22T08:00:00.000Z'),
          });
          return [{ affectedRows: 1 }, []];
        }

        if (sql.startsWith('INSERT INTO community_subscriptions')) {
          const [userId, communityId] = values as [string, string];
          subscriptions.add(`${userId}:${communityId}`);
          return [{ affectedRows: 1 }, []];
        }

        if (sql.startsWith('DELETE FROM community_subscriptions')) {
          const [userId, communityId] = values as [string, string];
          subscriptions.delete(`${userId}:${communityId}`);
          return [{ affectedRows: 1 }, []];
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
          return [rows.slice(offset, offset + limit), []];
        }

        if (sql.includes('WHERE id = ?')) {
          const [id] = values as [string];
          return [communities.filter((community) => community.id === id), []];
        }

        if (sql.includes('WHERE name = ?')) {
          const [name] = values as [string];
          return [
            communities.filter((community) => community.name === name),
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
        validateAccessToken: async (token: string) =>
          token === 'valid-token' ? 'authenticated-user' : null,
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
        rules: 'Have fun',
      })
      .expect(201);

    expect(response.body).toMatchObject({
      creator_id: 'authenticated-user',
      name: 'board-games',
      description: 'Games and friends',
      rules: 'Have fun',
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
      .send({ name: 'valid', rules: 'x'.repeat(16384) })
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
      'rules',
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
});
