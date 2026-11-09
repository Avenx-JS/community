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
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import { UsersService } from '../src/users/users.service';
import {
  executeCommunityDirectoryQuery,
  type CommunityDirectoryStore,
  type FakeDirectoryCommunity,
} from './fakes/admin-communities-pool';

interface Item {
  id: string;
  name: string;
  creator_username: string | null;
  member_count: number;
  post_count: number;
  [key: string]: unknown;
}
interface ListBody {
  items: Item[];
  page: number;
  limit: number;
  total: number;
  filters: Record<string, unknown>;
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

describe('Admin communities API (e2e)', () => {
  let app: INestApplication<App>;
  let store: CommunityDirectoryStore;
  let failAudit: boolean;
  let tx: { commits: number; rollbacks: number; releases: number };

  beforeEach(async () => {
    const community = (
      n: number,
      overrides: Partial<FakeDirectoryCommunity> = {},
    ): FakeDirectoryCommunity => ({
      id: `c-${String(n).padStart(2, '0')}`,
      creator_id: n % 2 ? 'u-alice' : 'u-bob',
      name: `community-${n}`,
      description: `About community ${n}`,
      created_at: day(n),
      deleted_at: null,
      deleted_by: null,
      suspended_at: null,
      suspended_by: null,
      suspension_reason: null,
      ...overrides,
    });
    store = {
      users: [
        {
          id: 'u-admin',
          username: 'admin',
          email: 'admin@example.com',
          deleted: false,
        },
        {
          id: 'u-alice',
          username: 'alice',
          email: 'alice@example.com',
          deleted: false,
        },
        {
          id: 'u-bob',
          username: 'bob',
          email: 'bob@example.com',
          deleted: false,
        },
        {
          id: 'u-gone',
          username: 'deleted_u-gone',
          email: 'deleted_u-gone@invalid',
          deleted: true,
        },
      ],
      communities: [
        ...Array.from({ length: 22 }, (_, index) => community(index + 1)),
        community(23, {
          name: 'suspended-one',
          description: '50% off_sale = spam',
          suspended_at: day(25),
          suspended_by: 'u-gone',
          suspension_reason: 'Spam network',
        }),
        community(24, {
          name: 'deleted-one',
          deleted_at: day(26),
          deleted_by: 'u-alice',
        }),
        community(25, {
          name: 'deleted-and-suspended',
          creator_id: 'u-gone',
          deleted_at: day(27),
          deleted_by: 'u-gone',
          suspended_at: day(26),
        }),
      ],
      subscriptions: [
        { community_id: 'c-01', user_id: 'u-alice' },
        { community_id: 'c-01', user_id: 'u-bob' },
        { community_id: 'c-23', user_id: 'u-bob' },
      ],
      moderators: [{ community_id: 'c-23', user_id: 'u-bob' }],
      posts: [
        { id: 'p-1', community_id: 'c-23' },
        { id: 'p-2', community_id: 'c-23' },
        { id: 'p-3', community_id: 'c-01' },
      ],
      comments: [
        { id: 'm-1', post_id: 'p-1' },
        { id: 'm-2', post_id: 'p-2' },
        { id: 'm-3', post_id: 'p-3' },
      ],
      ruleVersions: [
        { community_id: 'c-23', version: 1 },
        { community_id: 'c-23', version: 3 },
      ],
      reports: [
        {
          target_type: 'community',
          target_id: 'c-23',
          status: 'open',
          withdrawn: false,
        },
        {
          target_type: 'community',
          target_id: 'c-23',
          status: 'under_review',
          withdrawn: false,
        },
        {
          target_type: 'community',
          target_id: 'c-23',
          status: 'resolved',
          withdrawn: false,
        },
        {
          target_type: 'community',
          target_id: 'c-23',
          status: 'open',
          withdrawn: true,
        },
        {
          target_type: 'user',
          target_id: 'c-23',
          status: 'open',
          withdrawn: false,
        },
      ],
      audit: [],
    };
    failAudit = false;
    tx = { commits: 0, rollbacks: 0, releases: 0 };
    let before: string | null = null;

    const run = (sql: string, values: unknown[] = []) => {
      if (failAudit && sql.startsWith('INSERT INTO admin_actions')) {
        return Promise.reject(new Error('Audit insert failed'));
      }
      const result = executeCommunityDirectoryQuery(store, sql, values);
      return result
        ? Promise.resolve(result)
        : Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    };

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute: run,
        getConnection: () =>
          Promise.resolve({
            beginTransaction: () => {
              before = JSON.stringify(store.communities);
              return Promise.resolve();
            },
            commit: () => {
              tx.commits += 1;
              return Promise.resolve();
            },
            rollback: () => {
              tx.rollbacks += 1;
              if (before) {
                store.communities = JSON.parse(
                  before,
                ) as FakeDirectoryCommunity[];
              }
              return Promise.resolve();
            },
            release: () => {
              tx.releases += 1;
            },
            execute: run,
          }),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            token === 'admin-token'
              ? { kind: 'valid', userId: 'u-admin' }
              : token === 'user-token'
                ? { kind: 'valid', userId: 'u-alice' }
                : { kind: 'invalid' },
          ),
      })
      .overrideProvider(UsersService)
      .useValue({
        getPlatformRole: (userId: string) =>
          Promise.resolve(userId === 'u-admin' ? 'admin' : 'user'),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
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

  const as = (token: string | null) => {
    const auth = (test: request.Test) =>
      token === null ? test : test.set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => auth(request(app.getHttpServer()).get(path)),
      patch: (path: string, body: object) =>
        auth(request(app.getHttpServer()).patch(path)).send(body),
    };
  };
  const admin = as('admin-token');
  const listed = async (query = '') =>
    (await admin.get(`/admin/communities${query}`).expect(200))
      .body as ListBody;
  const names = (body: ListBody) => body.items.map((item) => item.name);

  it.each([
    ['GET', '/admin/communities'],
    ['GET', '/admin/communities/c-01'],
    ['PATCH', '/admin/communities/c-01'],
  ])('guards %s %s like every admin route', async (method, path) => {
    const call = (who: string | null) =>
      method === 'GET'
        ? as(who).get(path)
        : as(who).patch(path, { description: 'x' });
    await call(null).expect(401);
    await call('user-token').expect(403);
    expect(store.audit).toHaveLength(0);
  });

  describe('GET /admin/communities', () => {
    it('lists every community by default, hidden ones included', async () => {
      const body = await listed('?limit=100');
      expect(body).toMatchObject({ page: 1, limit: 100, total: 25 });
      expect(body.filters).toEqual({
        search: null,
        creator_username: null,
        state: 'any',
        sort: 'new',
      });
      expect(names(body).slice(0, 3)).toEqual([
        'deleted-and-suspended',
        'deleted-one',
        'suspended-one',
      ]);
      expect(Object.keys(body.items[0]).sort()).toEqual(
        [
          'id',
          'name',
          'description',
          'creator_username',
          'created_at',
          'suspended_at',
          'deleted_at',
          'member_count',
          'post_count',
        ].sort(),
      );
    });

    // The test that justifies the endpoint.
    it('returns the communities the public listing hides', async () => {
      const publicNames = (
        (
          await request(app.getHttpServer())
            .get('/communities?limit=100')
            .expect(200)
        ).body as { items: Array<{ name: string }> }
      ).items.map((item) => item.name);
      const adminNames = names(await listed('?limit=100'));
      const hidden = adminNames.filter((name) => !publicNames.includes(name));
      expect(hidden.sort()).toEqual(['deleted-and-suspended', 'deleted-one']);
      expect(publicNames.every((name) => adminNames.includes(name))).toBe(true);
    });

    it.each([
      ['active', 22, []],
      ['suspended', 1, ['suspended-one']],
      ['deleted', 2, ['deleted-and-suspended', 'deleted-one']],
    ] as const)('filters state=%s', async (state, total, hiddenNames) => {
      const body = await listed(`?state=${state}&limit=100`);
      expect(body.total).toBe(total);
      if (hiddenNames.length) {
        expect(names(body)).toEqual(hiddenNames);
      }
      expect(body.filters.state).toBe(state);
    });

    it('counts members and posts per community', async () => {
      const items = (await listed('?limit=100')).items;
      const byName = Object.fromEntries(items.map((item) => [item.name, item]));
      expect(byName['community-1']).toMatchObject({
        member_count: 2,
        post_count: 1,
      });
      expect(byName['suspended-one']).toMatchObject({
        member_count: 1,
        post_count: 2,
      });
      expect(byName['community-2']).toMatchObject({
        member_count: 0,
        post_count: 0,
      });
    });

    it('renders a deleted creator as null without failing', async () => {
      const body = await listed('?state=deleted');
      expect(body.items[0]).toMatchObject({
        name: 'deleted-and-suspended',
        creator_username: null,
      });
    });

    it('searches name and description case-insensitively, with wildcards escaped', async () => {
      expect(names(await listed('?search=SUSPENDED-ONE'))).toEqual([
        'suspended-one',
      ]);
      expect(names(await listed('?search=50%25%20off_sale'))).toEqual([
        'suspended-one',
      ]);
      // Unescaped, % and _ would match all 25; escaped, only the one
      // description that contains them literally.
      expect(names(await listed('?search=%25'))).toEqual(['suspended-one']);
      expect(names(await listed('?search=_'))).toEqual(['suspended-one']);
      expect(names(await listed('?search=%3D%20spam'))).toEqual([
        'suspended-one',
      ]);
      expect((await listed('?search=about%20community%201')).total).toBe(11);
    });

    it('filters by creator, and answers a miss with an empty 200', async () => {
      expect((await listed('?creator_username=bob&limit=100')).total).toBe(12);
      const none = await listed('?creator_username=nobody');
      expect(none).toMatchObject({ items: [], total: 0 });
      expect((await listed('?search=zebra')).items).toEqual([]);
    });

    it.each(['new', 'oldest'])(
      'pages with a stable order, each community exactly once (%s)',
      async (sort) => {
        const seen: string[] = [];
        for (let page = 1; page <= 4; page += 1) {
          seen.push(
            ...(await listed(`?sort=${sort}&limit=7&page=${page}`)).items.map(
              (item) => item.id,
            ),
          );
        }
        expect(seen).toHaveLength(25);
        expect(new Set(seen).size).toBe(25);
        expect(seen[0]).toBe(sort === 'new' ? 'c-25' : 'c-01');
      },
    );

    it.each([
      '?state=hidden',
      '?page=0',
      '?page=10001',
      '?limit=101',
      '?sort=name',
      `?search=${'x'.repeat(101)}`,
      '?creator_username=a-b',
      '?unexpected=1',
    ])('answers %s with 400', async (query) => {
      await admin.get(`/admin/communities${query}`).expect(400);
    });
  });

  describe('GET /admin/communities/:id', () => {
    it('returns a suspended community with every detail field', async () => {
      const body = (await admin.get('/admin/communities/c-23').expect(200))
        .body as Record<string, unknown>;
      expect(body).toEqual({
        id: 'c-23',
        name: 'suspended-one',
        description: '50% off_sale = spam',
        creator_username: 'alice',
        created_at: day(23),
        suspended_at: day(25),
        deleted_at: null,
        member_count: 1,
        post_count: 2,
        suspended_by_username: null,
        suspension_reason: 'Spam network',
        deleted_by_username: null,
        moderator_count: 1,
        comment_count: 2,
        rule_version: 3,
        open_report_count: 2,
      });
    });

    it('returns a soft-deleted community, with null for deleted accounts', async () => {
      const body = (await admin.get('/admin/communities/c-25').expect(200))
        .body as Record<string, unknown>;
      expect(body).toMatchObject({
        deleted_at: day(27),
        creator_username: null,
        deleted_by_username: null,
        rule_version: null,
        open_report_count: 0,
      });
      const deleted = (await admin.get('/admin/communities/c-24').expect(200))
        .body as Record<string, unknown>;
      expect(deleted.deleted_by_username).toBe('alice');
    });

    it('answers an unknown id with 404 and a malformed one with 400', async () => {
      await admin.get('/admin/communities/no-such-id').expect(404);
      await admin.get(`/admin/communities/${'x'.repeat(37)}`).expect(400);
      await admin.get('/admin/communities/bad.id').expect(400);
    });
  });

  describe('PATCH /admin/communities/:id', () => {
    it('corrects the description, audits it once, and returns the detail', async () => {
      const body = (
        await admin
          .patch('/admin/communities/c-23', {
            description: '  A cleaned-up description  ',
          })
          .expect(200)
      ).body as Record<string, unknown>;
      expect(body).toMatchObject({
        id: 'c-23',
        description: 'A cleaned-up description',
        open_report_count: 2,
      });
      expect(store.audit).toHaveLength(1);
      const [, actor, actorName, action, targetType, targetId, metadata] =
        store.audit[0];
      expect([actor, actorName, action, targetType, targetId]).toEqual([
        'u-admin',
        'admin',
        'community_updated',
        'community',
        'c-23',
      ]);
      expect(JSON.parse(String(metadata))).toEqual({
        community_name: 'suspended-one',
        fields: 'description',
      });
      expect(tx).toEqual({ commits: 1, rollbacks: 0, releases: 1 });
    });

    it('works on a soft-deleted community too', async () => {
      await admin
        .patch('/admin/communities/c-24', { description: 'Fixed' })
        .expect(200);
    });

    it('stores a whitespace-only description as NULL', async () => {
      const body = (
        await admin
          .patch('/admin/communities/c-01', { description: '   ' })
          .expect(200)
      ).body as Record<string, unknown>;
      expect(body.description).toBeNull();
    });

    it.each([
      [{}],
      [{ name: 'renamed' }],
      [{ rules: 'New rules' }],
      [{ description: 'x', name: 'renamed' }],
      [{ description: 'x', rules: 'New rules' }],
      [{ description: 'x', creator_id: 'u-bob' }],
      [{ description: 'x', suspended_at: null }],
      [{ description: 'x', deleted_at: null }],
      [{ description: 'x', unexpected: 1 }],
      [{ description: 'x'.repeat(16384) }],
      [{ description: 'bad\u0000text' }],
      [{ description: null }],
    ])('answers %o with 400 and writes nothing', async (body) => {
      await admin.patch('/admin/communities/c-01', body).expect(400);
      expect(store.communities[0].description).toBe('About community 1');
      expect(store.audit).toHaveLength(0);
    });

    it('answers an unknown id with 404 and writes nothing', async () => {
      await admin
        .patch('/admin/communities/no-such-id', { description: 'x' })
        .expect(404);
      expect(store.audit).toHaveLength(0);
      expect(tx).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });

    it('rolls the change back when the audit entry cannot be written', async () => {
      failAudit = true;
      await admin
        .patch('/admin/communities/c-01', { description: 'Changed' })
        .expect(500);
      expect(store.communities[0].description).toBe('About community 1');
      expect(tx).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });
  });

  it('never serialises an email, password hash, token or session', async () => {
    const responses = [
      await admin.get('/admin/communities?limit=100').expect(200),
      await admin.get('/admin/communities/c-23').expect(200),
      await admin
        .patch('/admin/communities/c-23', { description: 'x' })
        .expect(200),
    ];
    for (const response of responses) {
      expect(response.text).not.toMatch(
        /@example\.com|@invalid|email|password|token|session/,
      );
    }
  });

  it('adds no suspend or restore route', async () => {
    for (const action of ['suspend', 'restore']) {
      await request(app.getHttpServer())
        .post(`/admin/communities/c-01/${action}`)
        .set('Authorization', 'Bearer admin-token')
        .expect(404);
    }
  });
});
