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
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';

const REPORTER = 'token-user-id';
const AUTHOR = 'target-user-id';

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
}

describe('Report endpoint (e2e)', () => {
  let app: INestApplication<App>;
  let stored: StoredReport[];
  let rateLimitRetry: number | null;
  let rateLimitCalls: Array<{
    ip: string;
    method: string;
    path: string;
    accountId?: string;
  }>;

  beforeEach(async () => {
    stored = [];
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
    const execute = (sql: string, values: unknown[]) => {
      const key = values[0] as string;
      let rows: unknown[] = [];
      if (sql.startsWith('SELECT id, username FROM users')) {
        if (key !== 'unknown_user') {
          rows = [
            { id: key === 'reporter' ? REPORTER : AUTHOR, username: key },
          ];
        }
      } else if (sql.startsWith('SELECT author_id FROM posts')) {
        rows = key in posts ? [{ author_id: posts[key] }] : [];
      } else if (sql.startsWith('SELECT author_id FROM comments')) {
        rows = key in comments ? [{ author_id: comments[key] }] : [];
      } else if (sql.startsWith('SELECT id, creator_id FROM communities')) {
        rows = key in communities ? [communities[key]] : [];
      }
      return Promise.resolve([rows, []] as [unknown, unknown]);
    };
    const connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
      execute: (sql: string, values: unknown[]) => {
        if (sql.startsWith('SELECT id FROM user_reports')) {
          const [reporter, type, id, contextType, contextId] = values;
          return Promise.resolve([
            stored.filter(
              (report) =>
                ['open', 'under_review'].includes(report.status) &&
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
          });
          return Promise.resolve([{ affectedRows: 1 }, []] as [
            unknown,
            unknown,
          ]);
        }
        if (sql.startsWith('SELECT created_at FROM user_reports')) {
          return Promise.resolve([
            [{ created_at: '2026-10-25T10:00:00.000Z' }],
            [],
          ] as [unknown, unknown]);
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
});
