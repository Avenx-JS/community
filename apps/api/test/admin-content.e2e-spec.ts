import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  ADMIN_COMMENT_DETAIL_SQL,
  ADMIN_POST_DETAIL_SQL,
  ADMIN_REMOVE_SQL,
  ADMIN_RESTORE_SQL,
  LOCK_COMMENT_SQL,
  LOCK_POST_SQL,
} from '../src/admin/admin-content.service';
import {
  ACTIVE_RESTRICTION_SQL,
  LOCK_ROLE_TARGET_SQL,
  ROLE_TARGET_SQL,
  SET_ROLE_SQL,
} from '../src/admin/admin-roles.service';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import { CLOSE_COMMUNITY_REPORTS_SQL } from '../src/reports/community-report-review';
import { ACTIVE_ADMINS_SQL, UsersService } from '../src/users/users.service';

interface FakeUser {
  id: string;
  username: string;
  role: 'user' | 'moderator' | 'admin';
  deleted_at: Date | null;
}

interface FakeContent {
  id: string;
  kind: 'post' | 'comment';
  post_id?: string;
  author_id: string;
  community_id: string;
  community_name: string;
  community_state: 'active' | 'suspended' | 'deleted';
  removed_at: Date | null;
  removed_by: string | null;
  removal_reason: string | null;
  removed_by_admin: number;
}

const created = new Date('2026-11-01T10:00:00.000Z');

// The admin content, role and analytics statements, answered from a small
// store. A rollback restores the store as it was at begin.
describe('Admin content, roles and analytics (e2e)', () => {
  let app: INestApplication<App>;
  let users: FakeUser[];
  let content: FakeContent[];
  let restricted: Set<string>;
  let audit: unknown[][];
  let notifications: unknown[][];
  let tx: { commits: number; rollbacks: number };

  const contentOf = (id: string, kind: 'post' | 'comment') =>
    content.find((row) => row.id === id && row.kind === kind);
  const postOf = (row: FakeContent) =>
    row.kind === 'post' ? row : contentOf(row.post_id!, 'post')!;
  const detail = (row: FakeContent) => ({
    id: row.id,
    community_id: row.community_id,
    community_name: row.community_name,
    community_state: row.community_state,
    author_id: row.author_id,
    author_username: users.find((user) => user.id === row.author_id)?.username,
    created_at: created,
    edited_at: null,
    score: 1,
    locked_at: null,
    removed_at: row.removed_at,
    removed_by: row.removed_by,
    removed_by_username:
      users.find((user) => user.id === row.removed_by)?.username ?? null,
    removal_reason: row.removal_reason,
    removed_by_admin: row.removed_by_admin,
    title: 'Tomatoes',
    type: 'text',
    pinned_at: null,
    content: 'Body',
    upvotes: 1,
    downvotes: 0,
    comment_count: 1,
    reply_count: 0,
    open_report_count: 0,
    post_id: row.post_id,
    post_title: 'Tomatoes',
    post_removed_at: postOf(row).removed_at,
    parent_id: null,
    excerpt: 'Body',
  });

  beforeEach(async () => {
    users = [
      { id: 'u-admin', username: 'root', role: 'admin', deleted_at: null },
      { id: 'u-admin2', username: 'second', role: 'admin', deleted_at: null },
      { id: 'u-mod', username: 'pmod', role: 'moderator', deleted_at: null },
      { id: 'u-sam', username: 'sam', role: 'user', deleted_at: null },
      {
        id: 'u-gone',
        username: 'deleted_u-gone',
        role: 'user',
        deleted_at: created,
      },
    ];
    const base = {
      author_id: 'u-sam',
      community_id: 'c-1',
      community_name: 'garden',
      removed_at: null,
      removed_by: null,
      removal_reason: null,
      removed_by_admin: 0,
    };
    content = [
      // In a suspended community: every public route answers 404 for it.
      { ...base, id: 'p-1', kind: 'post', community_state: 'suspended' },
      {
        ...base,
        id: 'p-2',
        kind: 'post',
        community_state: 'deleted',
        removed_at: created,
        removed_by: 'u-sam',
        removal_reason: 'Moderator call',
      },
      {
        ...base,
        id: 'm-1',
        kind: 'comment',
        post_id: 'p-1',
        community_state: 'suspended',
      },
      {
        ...base,
        id: 'm-2',
        kind: 'comment',
        post_id: 'p-2',
        community_state: 'deleted',
        removed_at: created,
        removed_by_admin: 1,
        removed_by: 'u-admin',
      },
    ];
    restricted = new Set(['u-sam']);
    audit = [];
    notifications = [];
    tx = { commits: 0, rollbacks: 0 };
    let before = '';

    const result = (rows: unknown) => Promise.resolve([rows, []]);
    const run = (sql: string, values: unknown[] = []) => {
      const id = values[0] as string;
      if (sql === ACTIVE_ADMINS_SQL) {
        return result(
          users
            .filter((user) => user.role === 'admin' && !user.deleted_at)
            .map(({ id: userId }) => ({ id: userId })),
        );
      }
      if (sql === ROLE_TARGET_SQL || sql === LOCK_ROLE_TARGET_SQL) {
        return result(users.filter((user) => user.id === id));
      }
      if (sql === ACTIVE_RESTRICTION_SQL) {
        return result(restricted.has(id) ? [{ id: 'r-1' }] : []);
      }
      if (sql === SET_ROLE_SQL) {
        users.find((user) => user.id === values[1])!.role =
          values[0] as FakeUser['role'];
        return result({ affectedRows: 1 });
      }
      if (sql === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
        return result(users.filter((user) => user.id === id));
      }
      if (sql.startsWith('INSERT INTO admin_actions')) {
        audit.push(values);
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('INSERT INTO notifications')) {
        notifications.push(values);
        return result({ affectedRows: 1 });
      }
      if (sql === CLOSE_COMMUNITY_REPORTS_SQL) {
        return result({ affectedRows: 0 });
      }
      if (sql === LOCK_POST_SQL || sql === LOCK_COMMENT_SQL) {
        const row = contentOf(id, sql === LOCK_POST_SQL ? 'post' : 'comment');
        return result(
          row ? [{ ...detail(row), title: 'Tomatoes', content: 'Body' }] : [],
        );
      }
      for (const kind of ['post', 'comment'] as const) {
        const table = kind === 'post' ? 'posts' : 'comments';
        if (sql === ADMIN_REMOVE_SQL(table)) {
          const row = contentOf(values[2] as string, kind)!;
          Object.assign(row, {
            removed_at: created,
            removed_by: values[0],
            removal_reason: values[1],
            removed_by_admin: 1,
          });
          return result({ affectedRows: 1 });
        }
        if (sql === ADMIN_RESTORE_SQL(table)) {
          const row = contentOf(id, kind)!;
          Object.assign(row, {
            removed_at: null,
            removed_by: null,
            removal_reason: null,
            removed_by_admin: 0,
          });
          return result({ affectedRows: 1 });
        }
      }
      if (sql === ADMIN_POST_DETAIL_SQL || sql === ADMIN_COMMENT_DETAIL_SQL) {
        const row = contentOf(
          id,
          sql === ADMIN_POST_DETAIL_SQL ? 'post' : 'comment',
        );
        return result(row ? [detail(row)] : []);
      }
      // The listings: every row of the kind, narrowed by the state the
      // statement names.
      const listing = /^SELECT (p|cm)\.id,/.exec(sql);
      const counting =
        /^SELECT COUNT\(\*\) AS total FROM (posts p|comments cm)/.exec(sql);
      if (listing || counting) {
        const kind = (listing?.[1] ?? counting![1]).startsWith('p')
          ? 'post'
          : 'comment';
        const rows = content
          .filter((row) => row.kind === kind)
          .filter((row) =>
            sql.includes('removed_by_admin = TRUE')
              ? row.removed_by_admin === 1
              : true,
          )
          .filter((row) =>
            sql.includes('c.suspended_at IS NOT NULL AND c.deleted_at IS NULL')
              ? row.community_state === 'suspended'
              : true,
          );
        return listing
          ? result(rows.map(detail))
          : result([{ total: rows.length }]);
      }
      // Analytics: grouped counts, empty here.
      if (/^SELECT (FLOOR|CASE|COUNT)/.test(sql)) {
        return result(sql.startsWith('SELECT COUNT') ? [{ total: 0 }] : []);
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
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
              before = JSON.stringify({ users, content, audit, notifications });
              return Promise.resolve();
            },
            commit: () => {
              tx.commits += 1;
              return Promise.resolve();
            },
            rollback: () => {
              tx.rollbacks += 1;
              const restored = JSON.parse(before, (key, value: unknown) =>
                (key === 'removed_at' || key === 'deleted_at') &&
                typeof value === 'string'
                  ? new Date(value)
                  : value,
              ) as {
                users: FakeUser[];
                content: FakeContent[];
                audit: unknown[][];
                notifications: unknown[][];
              };
              ({ users, content, audit, notifications } = restored);
              return Promise.resolve();
            },
            release: () => undefined,
            execute: run,
          }),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) => {
          const userId = {
            'admin-token': 'u-admin',
            'admin2-token': 'u-admin2',
            'mod-token': 'u-mod',
            'user-token': 'u-sam',
          }[token];
          return Promise.resolve(
            userId
              ? { kind: 'valid', emailVerified: true, userId }
              : { kind: 'invalid' },
          );
        },
      })
      // The guard reads the role the role routes write, per request.
      .overrideProvider(UsersService)
      .useValue({
        getPlatformRole: (userId: string) => {
          const user = users.find((entry) => entry.id === userId);
          return Promise.resolve(user && !user.deleted_at ? user.role : null);
        },
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
    const server = () => request(app.getHttpServer());
    return {
      get: (path: string) => auth(server().get(path)),
      post: (path: string, body: object = {}) =>
        auth(server().post(path)).send(body),
      delete: (path: string, body: object = {}) =>
        auth(server().delete(path)).send(body),
    };
  };
  const admin = as('admin-token');

  it.each([
    ['GET', '/admin/posts'],
    ['GET', '/admin/posts/p-1'],
    ['POST', '/admin/posts/p-1/remove'],
    ['POST', '/admin/posts/p-1/restore'],
    ['GET', '/admin/comments'],
    ['GET', '/admin/comments/m-1'],
    ['POST', '/admin/comments/m-1/remove'],
    ['POST', '/admin/comments/m-1/restore'],
    ['GET', '/admin/users/u-sam/roles'],
    ['POST', '/admin/users/u-sam/roles'],
    ['DELETE', '/admin/users/u-sam/roles/moderator'],
    ['GET', '/admin/analytics/content'],
    ['GET', '/admin/analytics/communities'],
  ])(
    '%s %s: 401 without a token, 403 for members and platform moderators',
    async (method, path) => {
      const call = (token: string | null) =>
        method === 'GET'
          ? as(token).get(path)
          : method === 'POST'
            ? as(token).post(path, { reason: 'x', role: 'admin' })
            : as(token).delete(path, { reason: 'x' });
      await call(null).expect(401);
      await call('user-token').expect(403);
      await call('mod-token').expect(403);
      expect(audit).toEqual([]);
      expect(users.find((user) => user.id === 'u-sam')!.role).toBe('user');
    },
  );

  describe('content', () => {
    it('lists and reads content in suspended and deleted communities, with its removal source', async () => {
      const list = await admin.get('/admin/posts').expect(200);
      expect(
        (list.body as { items: { id: string }[] }).items.map((item) => item.id),
      ).toEqual(['p-1', 'p-2']);
      expect(list.body).toMatchObject({ page: 1, limit: 20, total: 2 });

      const suspended = await admin
        .get('/admin/comments?community_state=suspended')
        .expect(200);
      expect(suspended.body).toMatchObject({
        total: 1,
        items: [
          {
            id: 'm-1',
            community_state: 'suspended',
            removal: null,
            excerpt: 'Body',
          },
        ],
        filters: { community_state: 'suspended', post_id: null },
      });

      const removed = await admin.get('/admin/comments/m-2').expect(200);
      expect(removed.body).toMatchObject({
        community_state: 'deleted',
        post_removed: true,
        removal: { source: 'admin', removed_by_username: 'root' },
      });
      const moderated = await admin.get('/admin/posts/p-2').expect(200);
      expect(moderated.body).toMatchObject({
        removal: { source: 'moderator', reason: 'Moderator call' },
      });
      await admin.get('/admin/posts/nope').expect(404);
    });

    it.each([
      ['state=hidden'],
      ['community_state=gone'],
      ['author_username=a-b'],
      ['community_id=bad id'],
      ['limit=101'],
      ['post_id=x'],
    ])('rejects %s with 400', async (query) => {
      const path = query.startsWith('post_id')
        ? '/admin/posts'
        : '/admin/comments';
      await admin.get(`${path}?${query}`).expect(400);
    });

    it('removes a post in a suspended community, notifies its author, and audits who and why', async () => {
      const response = await admin
        .post('/admin/posts/p-1/remove', { reason: '  Doxxing  ' })
        .expect(200);
      expect(response.body).toMatchObject({
        id: 'p-1',
        removal: {
          source: 'admin',
          reason: 'Doxxing',
          removed_by_id: 'u-admin',
        },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].slice(1, 6)).toEqual([
        'u-admin',
        'root',
        'post_removed',
        'post',
        'p-1',
      ]);
      expect(JSON.parse(audit[0][6] as string)).toEqual({
        community_name: 'garden',
        previous_state: 'visible',
        reason: 'Doxxing',
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].slice(1, 6)).toEqual([
        'u-sam',
        'content_removed',
        null,
        'post',
        'p-1',
      ]);
      expect(notifications[0][7]).not.toContain('Doxxing');

      await admin
        .post('/admin/posts/p-1/remove', { reason: 'Again' })
        .expect(409);
      expect(audit).toHaveLength(1);
    });

    it("restores a moderator's removal, then 409 once visible", async () => {
      await admin
        .post('/admin/posts/p-2/restore', { reason: 'Appeal upheld' })
        .expect(200);
      expect(JSON.parse(audit[0][6] as string)).toMatchObject({
        previous_state: 'moderator_removed',
        reason: 'Appeal upheld',
      });
      expect(contentOf('p-2', 'post')!.removed_at).toBeNull();
      await admin.post('/admin/posts/p-2/restore', { reason: 'x' }).expect(409);
    });

    it('refuses to restore a comment while its post is removed', async () => {
      await admin
        .post('/admin/comments/m-2/restore', { reason: 'x' })
        .expect(409);
      expect(audit).toEqual([]);
    });

    it.each([
      [{}],
      [{ reason: '' }],
      [{ reason: '   ' }],
      [{ reason: 'x'.repeat(2001) }],
      [{ reason: 'ok', removed_by_admin: false }],
    ])('requires a valid reason and nothing else: %o is 400', async (body) => {
      await admin.post('/admin/comments/m-1/remove', body).expect(400);
      expect(audit).toEqual([]);
      expect(contentOf('m-1', 'comment')!.removed_at).toBeNull();
    });
  });

  describe('roles', () => {
    it('reads the one platform role', async () => {
      await admin.get('/admin/users/u-mod/roles').expect(200, {
        user_id: 'u-mod',
        username: 'pmod',
        role: 'moderator',
        roles: ['moderator'],
      });
      await admin.get('/admin/users/nope/roles').expect(404);
    });

    it('assigns and revokes, each audited with from, to and reason, and the guard follows at once', async () => {
      await admin
        .post('/admin/users/u-mod/roles', {
          role: 'admin',
          reason: 'Trust team',
        })
        .expect(200, {
          user_id: 'u-mod',
          username: 'pmod',
          role: 'admin',
          roles: ['admin'],
        });
      // The new administrator reaches /admin on the next request.
      await as('mod-token').get('/admin/posts').expect(200);

      await admin
        .delete('/admin/users/u-mod/roles/admin', { reason: 'Left the team' })
        .expect(200);
      await as('mod-token').get('/admin/posts').expect(403);

      expect(
        audit.map((entry): unknown[] => [
          entry[3],
          JSON.parse(entry[6] as string) as unknown,
        ]),
      ).toEqual([
        [
          'user_role_changed',
          { from_role: 'moderator', to_role: 'admin', reason: 'Trust team' },
        ],
        [
          'user_role_changed',
          { from_role: 'admin', to_role: 'user', reason: 'Left the team' },
        ],
      ]);
    });

    it('lets nobody change their own role', async () => {
      await admin
        .delete('/admin/users/u-admin/roles/admin', { reason: 'x' })
        .expect(403);
      await admin
        .post('/admin/users/u-admin/roles', { role: 'moderator', reason: 'x' })
        .expect(403);
      expect(users.find((user) => user.id === 'u-admin')!.role).toBe('admin');
      expect(audit).toEqual([]);
    });

    // Two administrators: each may demote the other, never both, and the one
    // left cannot demote themselves.
    it('always keeps an administrator', async () => {
      await as('admin2-token')
        .delete('/admin/users/u-admin/roles/admin', { reason: 'Rotation' })
        .expect(200);
      await admin
        .delete('/admin/users/u-admin2/roles/admin', { reason: 'x' })
        .expect(403);
      await as('admin2-token')
        .delete('/admin/users/u-admin2/roles/admin', { reason: 'x' })
        .expect(403);
      expect(
        users.filter((user) => user.role === 'admin').map((user) => user.id),
      ).toEqual(['u-admin2']);
    });

    it.each([
      [
        'a restricted account to admin',
        'u-sam',
        { role: 'admin', reason: 'x' },
        409,
      ],
      ['a deleted account', 'u-gone', { role: 'moderator', reason: 'x' }, 409],
      ['a role already held', 'u-mod', { role: 'moderator', reason: 'x' }, 409],
      ['the user role', 'u-sam', { role: 'user', reason: 'x' }, 400],
      ['an unknown role', 'u-sam', { role: 'owner', reason: 'x' }, 400],
      ['without a reason', 'u-sam', { role: 'moderator' }, 400],
      ['an unknown account', 'nope', { role: 'moderator', reason: 'x' }, 404],
    ])('refuses assigning %s', async (_, id, body, status) => {
      await admin.post(`/admin/users/${id}/roles`, body).expect(status);
      expect(audit).toEqual([]);
    });

    it.each([
      ['user', 400],
      ['owner', 400],
      ['admin', 404],
    ])(
      'refuses revoking %s from a plain member with %s',
      async (role, status) => {
        await admin
          .delete(`/admin/users/u-sam/roles/${role}`, { reason: 'x' })
          .expect(status);
        expect(audit).toEqual([]);
      },
    );

    it('lets a restricted account become a platform moderator', async () => {
      await admin
        .post('/admin/users/u-sam/roles', { role: 'moderator', reason: 'x' })
        .expect(200);
    });
  });

  describe('analytics', () => {
    it('answers aggregates only, zero-filled, for content and communities', async () => {
      const content = await admin
        .get(
          '/admin/analytics/content?from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:00Z',
        )
        .expect(200);
      expect(content.body).toMatchObject({
        totals: {
          posts: 0,
          comments: 0,
          votes: 0,
          posts_removed: 0,
          comments_removed: 0,
        },
        posts_by_type: { text: 0, link: 0, media: 0 },
        votes_by_value: { up: 0, down: 0 },
        removals_by_source: { moderator: 0, admin: 0 },
      });
      expect(
        (content.body as { series: { posts: unknown[] } }).series.posts,
      ).toHaveLength(2);

      const communities = await admin
        .get('/admin/analytics/communities?granularity=week')
        .expect(200);
      expect(communities.body).toMatchObject({
        granularity: 'week',
        totals: { total_communities: 0, active_communities: 0 },
        members_distribution: {
          '0': 0,
          '1-9': 0,
          '10-99': 0,
          '100-999': 0,
          '1000+': 0,
        },
      });
      expect(JSON.stringify([content.body, communities.body])).not.toMatch(
        /username|email|u-sam|garden/,
      );
    });

    it('rejects an invalid range with 400', async () => {
      await admin
        .get('/admin/analytics/content?from=2026-11-03&to=2026-11-01')
        .expect(400);
      await admin
        .get('/admin/analytics/communities?granularity=month')
        .expect(400);
    });
  });
});
