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
import { HttpAdapterHost } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { ApiRateLimitInterceptor } from '../src/common/api-rate-limit.interceptor';
import { CommunityRuleAcceptanceService } from '../src/communities/community-rule-acceptance.service';
import { CommunityBanPolicyService } from '../src/communities/community-ban-policy.service';
import { UserBlockPolicyService } from '../src/users/user-block-policy.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';

const REPORTER = 'token-user-id';
const OTHER_REPORTER = 'other-user-id';
const AUTHOR = 'target-user-id';
const FIRST_CREATED_AT = Date.parse('2026-10-25T10:00:00.000Z');

// What the target joins would resolve; anything absent reads as a missing target.
const TARGET_LABELS: Record<string, string> = {
  [AUTHOR]: 'target',
  'post-1': 'Post one',
  'post-2': 'Post two',
  'comment-1': 'A comment',
  'community-id': 'a-community',
};

interface StoredReport {
  id: unknown;
  reporter_id: unknown;
  reported_user_id: unknown;
  reason: unknown;
  description: unknown;
  context_type: unknown;
  context_id: unknown;
  target_type: unknown;
  target_id: unknown;
  target_author_id: unknown;
  status: string;
  created_at: string;
  withdrawn_at: string | null;
  // Moderator-only columns, set by tests to prove they never reach a reporter.
  resolution: string | null;
  resolution_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

describe('Report endpoint (e2e)', () => {
  let app: INestApplication<App>;
  let stored: StoredReport[];
  let releases: number;
  let rateLimitRetry: number | null;
  let rateLimitCalls: Array<{
    ip: string;
    method: string;
    path: string;
    accountId?: string;
  }>;

  beforeEach(async () => {
    stored = [];
    releases = 0;
    rateLimitRetry = null;
    rateLimitCalls = [];
    const posts: Record<string, string> = {
      'post-1': AUTHOR,
      'post-2': AUTHOR,
      // Resolution ignores content state, so these read like any other post.
      'removed-post': AUTHOR,
      'post-in-deleted-community': AUTHOR,
      'own-post': REPORTER,
    };
    const comments: Record<string, string> = {
      'comment-1': 'other-user-id',
      'removed-comment': AUTHOR,
      'own-comment': REPORTER,
    };
    const communities: Record<string, { id: string; creator_id: string }> = {
      'a-community': { id: 'community-id', creator_id: AUTHOR },
      'deleted-community': { id: 'deleted-id', creator_id: AUTHOR },
      'suspended-community': { id: 'suspended-id', creator_id: AUTHOR },
      'own-community': { id: 'own-id', creator_id: REPORTER },
    };
    // Returns whole stored rows, moderator-only columns included, so the
    // service's mapping is what keeps them out of a response.
    const ownReportRow = (report: StoredReport) => ({
      ...report,
      target_label: TARGET_LABELS[report.target_id as string] ?? null,
    });
    const ownReports = (sql: string, values: unknown[]) => {
      if (sql.includes('WHERE ur.id = ? AND ur.reporter_id = ?')) {
        return stored.filter(
          (report) =>
            report.id === values[0] && report.reporter_id === values[1],
        );
      }
      let parameter = 1;
      let result = stored.filter((report) => report.reporter_id === values[0]);
      if (sql.includes('ur.status = ?')) {
        const status = values[parameter++];
        result = result.filter((report) => report.status === status);
      }
      if (sql.includes('ur.target_type = ?')) {
        const type = values[parameter++];
        result = result.filter((report) => report.target_type === type);
      }
      const direction = sql.includes('ur.created_at ASC') ? 1 : -1;
      return [...result].sort(
        (left, right) =>
          direction *
          (left.created_at.localeCompare(right.created_at) ||
            String(left.id).localeCompare(String(right.id))),
      );
    };
    const execute = (sql: string, values: unknown[]) => {
      const key = values[0] as string;
      let rows: unknown[] = [];
      if (sql.startsWith('SELECT ur.id, ur.target_type')) {
        rows = ownReports(sql, values).map(ownReportRow);
        if (sql.includes('LIMIT ? OFFSET ?')) {
          const limit = Number(values[values.length - 2]);
          const offset = Number(values[values.length - 1]);
          rows = rows.slice(offset, offset + limit);
        }
      } else if (
        sql.startsWith('SELECT COUNT(*) AS total FROM user_reports ur')
      ) {
        rows = [{ total: ownReports(sql, values).length }];
      } else if (sql.startsWith('SELECT id, username FROM users')) {
        if (key !== 'unknown_user') {
          rows = [
            { id: key === 'reporter' ? REPORTER : AUTHOR, username: key },
          ];
        }
      } else if (sql.startsWith('SELECT author_id, community_id FROM posts')) {
        rows =
          key in posts
            ? [{ author_id: posts[key], community_id: 'community-of-content' }]
            : [];
      } else if (
        sql.startsWith(
          'SELECT comments.author_id, posts.community_id FROM comments',
        )
      ) {
        rows =
          key in comments
            ? [
                {
                  author_id: comments[key],
                  community_id: 'community-of-content',
                },
              ]
            : [];
      } else if (sql.startsWith('SELECT id, creator_id FROM communities')) {
        rows = key in communities ? [communities[key]] : [];
      }
      return Promise.resolve([rows, []] as [unknown, unknown]);
    };
    const connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => {
        releases += 1;
      },
      execute: (sql: string, values: unknown[]) => {
        if (sql.startsWith('SELECT id FROM user_reports')) {
          const [reporter, type, id, contextType, contextId] = values;
          // Follows the real predicate: a withdrawn report only stops
          // counting if the service's SQL says so.
          const ignoresWithdrawn = sql.includes('withdrawn_at IS NULL');
          return Promise.resolve([
            stored.filter(
              (report) =>
                ['open', 'under_review'].includes(report.status) &&
                (!ignoresWithdrawn || report.withdrawn_at === null) &&
                report.reporter_id === reporter &&
                report.target_type === type &&
                report.target_id === id &&
                report.context_type === contextType &&
                report.context_id === contextId,
            ),
            [],
          ] as [unknown, unknown]);
        }
        if (sql.startsWith('INSERT INTO user_reports')) {
          const [
            id,
            reporter_id,
            reported_user_id,
            reason,
            description,
            context_type,
            context_id,
            target_type,
            target_id,
            target_author_id,
          ] = values;
          stored.push({
            id,
            reporter_id,
            reported_user_id,
            reason,
            description,
            context_type,
            context_id,
            target_type,
            target_id,
            target_author_id,
            status: 'open',
            created_at: new Date(
              FIRST_CREATED_AT + stored.length * 60_000,
            ).toISOString(),
            withdrawn_at: null,
            resolution: null,
            resolution_note: null,
            reviewed_by: null,
            reviewed_at: null,
          });
          return Promise.resolve([{ affectedRows: 1 }, []] as [
            unknown,
            unknown,
          ]);
        }
        if (sql.startsWith('SELECT created_at FROM user_reports')) {
          return Promise.resolve([
            stored
              .filter((report) => report.id === values[0])
              .map((report) => ({ created_at: report.created_at })),
            [],
          ] as [unknown, unknown]);
        }
        if (
          sql.startsWith(
            'SELECT reporter_id, status, community_status, withdrawn_at',
          )
        ) {
          return Promise.resolve([
            stored.filter((report) => report.id === values[0]),
            [],
          ] as [unknown, unknown]);
        }
        if (sql.startsWith('UPDATE user_reports SET withdrawn_at')) {
          const report = stored.find(
            (row) =>
              row.id === values[0] &&
              row.reporter_id === values[1] &&
              row.withdrawn_at === null &&
              row.status === 'open',
          );
          if (report) {
            report.withdrawn_at = '2026-10-27T08:00:00.000Z';
          }
          return Promise.resolve([{ affectedRows: report ? 1 : 0 }, []] as [
            unknown,
            unknown,
          ]);
        }
        if (/^\s*DELETE\b/i.test(sql)) {
          return Promise.reject(new Error('Reports must never be deleted'));
        }
        return Promise.resolve([[], []] as [unknown, unknown]);
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({ execute, getConnection: () => Promise.resolve(connection) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            token === 'valid-token'
              ? { kind: 'valid', userId: REPORTER }
              : token === 'other-token'
                ? { kind: 'valid', userId: OTHER_REPORTER }
                : { kind: 'invalid' },
          ),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({
        enforceApiRequest: (
          ip: string,
          method: string,
          path: string,
          accountId?: string,
        ) => {
          rateLimitCalls.push({ ip, method, path, accountId });
          return Promise.resolve(rateLimitRetry);
        },
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
  });

  const submit = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/reports')
      .set('Authorization', 'Bearer valid-token')
      .send(body);
  const reportOf = (
    target_type: string,
    target: string,
    extra: Record<string, unknown> = {},
  ) => submit({ target_type, target, reason: 'spam', ...extra });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .post('/reports')
      .send({ target_type: 'user', target: 'target', reason: 'spam' })
      .expect(401);
    expect(stored).toHaveLength(0);
  });

  describe('submission of all four target types', () => {
    it.each([
      ['user', 'target', AUTHOR, AUTHOR, null, 'target'],
      ['post', 'post-1', 'post-1', AUTHOR, AUTHOR, null],
      [
        'comment',
        'comment-1',
        'comment-1',
        'other-user-id',
        'other-user-id',
        null,
      ],
      ['community', 'a-community', 'community-id', null, null, null],
    ])(
      'stores a %s target with the right columns and a reduced receipt',
      async (type, target, targetId, reported, author, username) => {
        const response = await reportOf(type, target).expect(201);

        expect(response.body).toEqual({
          id: expect.any(String) as unknown,
          target_type: type,
          target,
          reported_username: username,
          reason: 'spam',
          status: 'open',
          created_at: '2026-10-25T10:00:00.000Z',
        });
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
          reporter_id: REPORTER,
          target_type: type,
          target_id: targetId,
          reported_user_id: reported,
          target_author_id: author,
        });
      },
    );

    it('keeps the context-belongs-to-the-reported-user rule on a user target', async () => {
      await reportOf('user', 'target', {
        reason: 'harassment',
        description: 'Repeated unwanted contact',
        context_type: 'post',
        context_id: 'post-1',
      }).expect(201);
      expect(stored[0]).toMatchObject({
        context_type: 'post',
        context_id: 'post-1',
        reason: 'harassment',
        target_type: 'user',
        target_id: AUTHOR,
        reported_user_id: AUTHOR,
        target_author_id: null,
      });
    });
  });

  describe('the refusal matrix', () => {
    it.each([
      ['user', 'has-hyphen'],
      ['user', 'ab'],
      ['post', 'p'.repeat(37)],
      ['comment', 'c'.repeat(37)],
    ])('answers the malformed %s target %s with 400', async (type, target) => {
      await reportOf(type, target).expect(400);
    });

    it.each([
      ['user', 'unknown_user'],
      ['post', 'missing-post'],
      ['comment', 'missing-comment'],
      ['community', 'missing-community'],
    ])('answers the unknown %s %s with 404', async (type, target) => {
      await reportOf(type, target).expect(404);
    });

    it.each([
      ['user', 'reporter'],
      ['post', 'own-post'],
      ['comment', 'own-comment'],
      ['community', 'own-community'],
    ])('answers your own %s with 400', async (type, target) => {
      await reportOf(type, target).expect(400);
    });

    it.each([
      ['post', 'post-1'],
      ['comment', 'comment-1'],
      ['community', 'a-community'],
    ])('answers context on a %s target with 400', async (type, target) => {
      await reportOf(type, target, {
        context_type: 'post',
        context_id: 'post-1',
      }).expect(400);
    });

    it.each([
      ['user', 'target'],
      ['post', 'post-1'],
      ['comment', 'comment-1'],
      ['community', 'a-community'],
    ])(
      'answers half a context pair on a %s target with 400',
      async (type, target) => {
        await reportOf(type, target, { context_type: 'post' }).expect(400);
        await reportOf(type, target, { context_id: 'post-1' }).expect(400);
      },
    );

    it('answers bad context on a user target as before', async () => {
      await reportOf('user', 'target', {
        context_type: 'post',
        context_id: 'missing-post',
      }).expect(404);
      await reportOf('user', 'target', {
        context_type: 'comment',
        context_id: 'comment-1',
      }).expect(400);
    });

    it('answers the removed username field with 400', async () => {
      await submit({ username: 'target', reason: 'spam' }).expect(400);
      await reportOf('user', 'target', { username: 'target' }).expect(400);
    });

    it('answers any other unknown property with 400', async () => {
      await reportOf('user', 'target', {
        reporter_id: 'another-user',
        status: 'resolved',
        resolution: 'user_banned',
      }).expect(400);
    });

    it('answers a missing or unknown discriminator with 400', async () => {
      await submit({ target: 'target', reason: 'spam' }).expect(400);
      await reportOf('account', 'target').expect(400);
    });

    afterEach(() => {
      expect(stored).toHaveLength(0);
    });
  });

  // A report is a request for review of something the reporter saw.
  it.each([
    ['post', 'removed-post'],
    ['comment', 'removed-comment'],
    ['post', 'post-in-deleted-community'],
    ['community', 'deleted-community'],
    ['community', 'suspended-community'],
  ])('accepts a report of the hidden %s %s', async (type, target) => {
    await reportOf(type, target).expect(201);
    expect(stored).toHaveLength(1);
  });

  describe('duplicates', () => {
    it('accepts two posts by one author; a second report of one post is 409', async () => {
      await reportOf('post', 'post-1').expect(201);
      await reportOf('post', 'post-2').expect(201);
      await reportOf('post', 'post-1').expect(409);
      expect(stored).toHaveLength(2);
    });

    it.each([
      ['comment', 'comment-1'],
      ['community', 'a-community'],
      ['user', 'target'],
    ])('answers a second %s report with 409', async (type, target) => {
      await reportOf(type, target).expect(201);
      await reportOf(type, target).expect(409);
      expect(stored).toHaveLength(1);
    });

    it('counts under_review as active, and permits a report after a decision', async () => {
      await reportOf('post', 'post-1').expect(201);
      stored[0].status = 'under_review';
      await reportOf('post', 'post-1').expect(409);

      stored[0].status = 'resolved';
      await reportOf('post', 'post-1').expect(201);
      expect(stored).toHaveLength(2);
    });

    it('still lets a user report differ by its evidence', async () => {
      const withPost = (id: string) =>
        reportOf('user', 'target', { context_type: 'post', context_id: id });
      await withPost('post-1').expect(201);
      await withPost('post-2').expect(201);
      await withPost('post-1').expect(409);
    });
  });

  describe('rate limiting', () => {
    it('reaches the per-route limiter by path, with the account', async () => {
      await reportOf('post', 'post-1').expect(201);
      expect(rateLimitCalls.at(-1)).toMatchObject({
        path: '/reports',
        method: 'POST',
        accountId: REPORTER,
      });
    });

    it.each([
      ['user', 'target'],
      ['post', 'post-1'],
      ['community', 'a-community'],
    ])(
      'rejects a limited %s submission with 429 and Retry-After',
      async (type, target) => {
        rateLimitRetry = 75;
        const response = await reportOf(type, target).expect(429);
        expect(response.headers['retry-after']).toBe('75');
        expect(stored).toHaveLength(0);
      },
    );
  });

  // Reporting is a safety mechanism: a user who has not accepted a community's
  // rules, perhaps because of what they just saw there, must still be able to
  // report it. Never gate this route on rule acceptance.
  it('accepts every target type without consulting rule acceptance', async () => {
    const check = jest
      .spyOn(app.get(CommunityRuleAcceptanceService), 'assertAcceptedOrThrow')
      .mockRejectedValue(new Error('rules not accepted'));

    await reportOf('user', 'target', {
      context_type: 'post',
      context_id: 'post-1',
    }).expect(201);
    await reportOf('post', 'post-1').expect(201);
    await reportOf('comment', 'comment-1').expect(201);
    await reportOf('community', 'a-community').expect(201);

    expect(stored).toHaveLength(4);
    expect(check).not.toHaveBeenCalled();
    check.mockRestore();
  });

  // The safety mechanism must stay reachable: a user can report the person
  // they blocked and the person who blocked them. Reporting never consults a
  // block, even one that would refuse everything.
  it('accepts every target type without consulting blocks', async () => {
    const policy = app.get(UserBlockPolicyService);
    const isBlocked = jest
      .spyOn(policy, 'isBlockedBetween')
      .mockResolvedValue(true);
    const assert = jest
      .spyOn(policy, 'assertNotBlockedOrThrow')
      .mockRejectedValue(new Error('blocked'));

    await reportOf('user', 'target', {
      context_type: 'post',
      context_id: 'post-1',
    }).expect(201);
    await reportOf('post', 'post-1').expect(201);
    await reportOf('comment', 'comment-1').expect(201);
    await reportOf('community', 'a-community').expect(201);

    expect(stored).toHaveLength(4);
    expect(isBlocked).not.toHaveBeenCalled();
    expect(assert).not.toHaveBeenCalled();
    isBlocked.mockRestore();
    assert.mockRestore();
  });

  // A banned user must still be able to report what they saw, including the
  // community that banned them: a ban never silences the safety mechanism.
  it('accepts every target type without consulting community bans', async () => {
    const check = jest
      .spyOn(app.get(CommunityBanPolicyService), 'assertNotBannedOrThrow')
      .mockRejectedValue(new Error('banned'));

    await reportOf('user', 'target').expect(201);
    await reportOf('post', 'post-1').expect(201);
    await reportOf('comment', 'comment-1').expect(201);
    await reportOf('community', 'a-community').expect(201);

    expect(stored).toHaveLength(4);
    expect(check).not.toHaveBeenCalled();
    check.mockRestore();
  });

  it('never returns an email, an internal id or a credential', async () => {
    for (const [type, target] of [
      ['user', 'target'],
      ['post', 'post-1'],
      ['community', 'a-community'],
    ]) {
      const response = await reportOf(type, target).expect(201);
      expect(response.text).not.toMatch(
        /email|password|token|session|target-user-id|community-id/,
      );
    }
  });

  describe('the reporter’s own reports', () => {
    const as = (token: string) => ({
      get: (path: string) =>
        request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${token}`),
      delete: (path: string) =>
        request(app.getHttpServer())
          .delete(path)
          .set('Authorization', `Bearer ${token}`),
    });
    const mine = as('valid-token');
    const theirs = as('other-token');
    const list = async (query = '') =>
      (await mine.get(`/reports${query}`).expect(200)).body as {
        items: Array<Record<string, unknown>>;
        page: number;
        limit: number;
        total: number;
      };
    const file = async (type: string, target: string) =>
      ((await reportOf(type, target).expect(201)).body as { id: string }).id;
    // Every field a reporter must never see, as a JSON key.
    const FORBIDDEN_KEYS =
      /"(resolution|resolution_note|reviewed_by|reviewed_by_username|reviewed_at|reported_user_id|reporter_id|target_id|target_author_id)"/;
    const moderated = (id: string) => {
      Object.assign(
        stored.find((report) => report.id === id)!,
        {
          status: 'resolved',
          resolution: 'user_banned',
          resolution_note: 'Internal: banned after three warnings',
          reviewed_by: 'admin-id',
          reviewed_at: '2026-10-26T12:00:00.000Z',
        },
      );
    };

    it('requires authentication on all three routes', async () => {
      await request(app.getHttpServer()).get('/reports').expect(401);
      await request(app.getHttpServer()).get('/reports/report-1').expect(401);
      await request(app.getHttpServer())
        .delete('/reports/report-1')
        .expect(401);
    });

    it('answers a reporter with no reports with an empty page', async () => {
      await expect(list()).resolves.toEqual({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
      });
    });

    it('lists the caller’s reports newest first, in the reporter-facing shape', async () => {
      const first = await file('user', 'target');
      const second = await file('post', 'post-1');
      const body = await list();

      expect(body.total).toBe(2);
      expect(body.items.map((item) => item.id)).toEqual([second, first]);
      expect(body.items[1]).toEqual({
        id: first,
        target_type: 'user',
        target_label: 'target',
        reason: 'spam',
        description: null,
        status: 'open',
        // An account report: administrators only.
        community_status: null,
        created_at: '2026-10-25T10:00:00.000Z',
        withdrawn_at: null,
      });
      expect((await list('?sort=oldest')).items[0].id).toBe(first);
    });

    it('labels each target type, and a missing target as null without failing', async () => {
      await file('user', 'target');
      await file('post', 'post-1');
      await file('comment', 'comment-1');
      await file('community', 'a-community');
      await file('post', 'removed-post');

      const labels = Object.fromEntries(
        (await list('?sort=oldest')).items.map((item) => [
          `${String(item.target_type)}:${String(item.id)}`,
          item.target_label,
        ]),
      );
      expect(Object.values(labels)).toEqual([
        'target',
        'Post one',
        'A comment',
        'a-community',
        null,
      ]);
    });

    it('filters on status and target_type, with a matching total', async () => {
      const post = await file('post', 'post-1');
      await file('comment', 'comment-1');
      await file('community', 'a-community');
      moderated(post);

      const resolved = await list('?status=resolved');
      expect(resolved.items.map((item) => item.id)).toEqual([post]);
      expect(resolved.total).toBe(1);

      const comments = await list('?target_type=comment');
      expect(comments.items.map((item) => item.target_type)).toEqual([
        'comment',
      ]);
      expect(comments.total).toBe(1);

      expect((await list('?status=open&target_type=post')).total).toBe(0);
    });

    it('pages within its bounds', async () => {
      for (const target of ['post-1', 'post-2', 'comment-1']) {
        await file(target.startsWith('post') ? 'post' : 'comment', target);
      }
      const page = await list('?limit=2&page=2');
      expect(page).toMatchObject({ page: 2, limit: 2, total: 3 });
      expect(page.items).toHaveLength(1);
    });

    it.each([
      '?page=0',
      '?page=10001',
      '?limit=0',
      '?limit=101',
      '?status=withdrawn',
      '?target_type=account',
      '?sort=random',
      '?reporter_id=other-user-id',
      '?unexpected=1',
    ])('answers %s with 400', async (query) => {
      await mine.get(`/reports${query}`).expect(400);
    });

    it('never returns another reporter’s reports, on any route', async () => {
      const id = await file('post', 'post-1');

      const other = (await theirs.get('/reports').expect(200)).body as {
        items: unknown[];
        total: number;
      };
      expect(other).toMatchObject({ items: [], total: 0 });

      // 404, never 403: a 403 would confirm the report exists.
      await theirs.get(`/reports/${id}`).expect(404);
      await theirs.delete(`/reports/${id}`).expect(404);
      expect(stored[0].withdrawn_at).toBeNull();

      await mine.get(`/reports/${id}`).expect(200);
    });

    it('reads one report, 404 for an unknown id, 400 for a malformed one', async () => {
      const id = await file('community', 'a-community');
      const response = await mine.get(`/reports/${id}`).expect(200);
      expect(response.body).toMatchObject({
        id,
        target_type: 'community',
        target_label: 'a-community',
        status: 'open',
      });

      await mine.get('/reports/no-such-report').expect(404);
      await mine.get(`/reports/${'x'.repeat(37)}`).expect(400);
      await mine.get('/reports/bad.id').expect(400);
      await mine.delete('/reports/no-such-report').expect(404);
      await mine.delete(`/reports/${'x'.repeat(37)}`).expect(400);
    });

    it('serialises no moderator-only field from any of the three routes', async () => {
      const decided = await file('user', 'target');
      moderated(decided);
      const open = await file('post', 'post-1');

      const listed = await mine.get('/reports').expect(200);
      const one = await mine.get(`/reports/${decided}`).expect(200);
      const withdrawn = await mine.delete(`/reports/${open}`).expect(204);

      for (const response of [listed, one, withdrawn]) {
        expect(response.text).not.toMatch(FORBIDDEN_KEYS);
        expect(response.text).not.toMatch(
          /user_banned|Internal: banned|admin-id|target-user-id/,
        );
      }
      expect(withdrawn.text).toBe('');
      // status is the one thing a reporter learns about the outcome.
      expect(one.body).toMatchObject({ status: 'resolved' });
    });

    it('round-trips submit, list, withdraw, list', async () => {
      const id = await file('post', 'post-1');
      expect((await list()).items[0]).toMatchObject({
        id,
        status: 'open',
        withdrawn_at: null,
      });

      await mine.delete(`/reports/${id}`).expect(204);

      // Kept, not deleted, and shown to its reporter as withdrawn.
      expect(stored).toHaveLength(1);
      const after = await list();
      expect(after.total).toBe(1);
      expect(after.items[0]).toMatchObject({
        id,
        status: 'open',
        withdrawn_at: '2026-10-27T08:00:00.000Z',
      });
    });

    describe('the withdrawal status matrix', () => {
      it('withdraws an open report with 204', async () => {
        const id = await file('post', 'post-1');
        await mine.delete(`/reports/${id}`).expect(204);
        expect(stored[0]).toMatchObject({
          status: 'open',
          withdrawn_at: '2026-10-27T08:00:00.000Z',
        });
      });

      it.each(['under_review', 'resolved', 'rejected'])(
        'answers a %s report with 409 and changes nothing',
        async (status) => {
          const id = await file('post', 'post-1');
          stored[0].status = status;
          const before = { ...stored[0] };

          await mine.delete(`/reports/${id}`).expect(409);
          expect(stored).toEqual([before]);
        },
      );

      it('answers a second withdrawal with 409 and keeps the first time', async () => {
        const id = await file('post', 'post-1');
        await mine.delete(`/reports/${id}`).expect(204);
        stored[0].withdrawn_at = '2026-10-27T07:00:00.000Z';

        await mine.delete(`/reports/${id}`).expect(409);
        expect(stored[0].withdrawn_at).toBe('2026-10-27T07:00:00.000Z');
      });
    });

    // The behaviour most likely to be missed: a withdrawn report keeps status
    // 'open', so the duplicate check must ignore it explicitly.
    it('frees the duplicate slot: report, 409, withdraw, report again', async () => {
      const id = await file('post', 'post-1');
      await reportOf('post', 'post-1').expect(409);

      await mine.delete(`/reports/${id}`).expect(204);
      await reportOf('post', 'post-1').expect(201);

      expect(stored).toHaveLength(2);
      expect(stored.map((report) => report.withdrawn_at)).toEqual([
        '2026-10-27T08:00:00.000Z',
        null,
      ]);
      // The new report holds the slot again.
      await reportOf('post', 'post-1').expect(409);
    });

    it('releases the connection on every withdrawal path', async () => {
      const id = await file('post', 'post-1');
      const afterCreate = releases;
      await mine.delete(`/reports/${id}`).expect(204);
      await mine.delete(`/reports/${id}`).expect(409);
      await theirs.delete(`/reports/${id}`).expect(404);
      await mine.delete('/reports/no-such-report').expect(404);
      expect(releases - afterCreate).toBe(4);
    });

    it('reaches the general rate limiter, with the account, on every route', async () => {
      const id = await file('post', 'post-1');
      rateLimitCalls = [];
      await mine.get('/reports').expect(200);
      await mine.get(`/reports/${id}`).expect(200);
      await mine.delete(`/reports/${id}`).expect(204);

      expect(rateLimitCalls.map(({ method }) => method)).toEqual([
        'GET',
        'GET',
        'DELETE',
      ]);
      for (const call of rateLimitCalls) {
        expect(call.accountId).toBe(REPORTER);
      }

      rateLimitRetry = 30;
      const limited = await mine.delete(`/reports/${id}`).expect(429);
      expect(limited.headers['retry-after']).toBe('30');
      await mine.get('/reports').expect(429);
    });
  });
});
