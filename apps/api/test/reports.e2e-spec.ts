import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
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
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';

describe('Report endpoint (e2e)', () => {
  let app: INestApplication<App>;
  let insertedReports: Array<Record<string, unknown>>;
  let existingReports: Array<{ id: string; status: string }>;
  let rateLimitRetry: number | null;
  let rateLimitCalls: Array<{
    ip: string;
    method: string;
    path: string;
    accountId?: string;
  }>;
  let pool: {
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
    getConnection: () => Promise<{
      beginTransaction: () => Promise<void>;
      commit: () => Promise<void>;
      rollback: () => Promise<void>;
      release: () => void;
      execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
    }>;
  };

  beforeEach(async () => {
    insertedReports = [];
    existingReports = [];
    rateLimitRetry = null;
    rateLimitCalls = [];
    const execute = (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT id, username FROM users')) {
        const username = values[0] as string;
        if (username === 'unknown_user') {
          return Promise.resolve([[], []] as [unknown, unknown]);
        }
        const id = username === 'reporter' ? 'token-user-id' : 'target-user-id';
        return Promise.resolve([[{ id, username }], []] as [unknown, unknown]);
      }
      if (sql.startsWith('SELECT author_id FROM posts')) {
        return Promise.resolve([
          values[0] === 'missing-post' ? [] : [{ author_id: 'target-user-id' }],
          [],
        ] as [unknown, unknown]);
      }
      if (sql.startsWith('SELECT author_id FROM comments')) {
        return Promise.resolve([
          values[0] === 'missing-comment'
            ? []
            : [{ author_id: 'other-user-id' }],
          [],
        ] as [unknown, unknown]);
      }
      return Promise.resolve([[], []] as [unknown, unknown]);
    };
    const connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
      execute: (sql: string, values: unknown[]) => {
        if (sql.startsWith('SELECT id FROM user_reports')) {
          return Promise.resolve([
            existingReports.filter((report) =>
              ['open', 'under_review'].includes(report.status),
            ),
            [],
          ] as [unknown, unknown]);
        }
        if (sql.startsWith('INSERT INTO user_reports')) {
          const [
            id,
            reporterId,
            reportedUserId,
            reason,
            description,
            type,
            contextId,
          ] = values;
          insertedReports.push({
            id,
            reporter_id: reporterId,
            reported_user_id: reportedUserId,
            reason,
            description,
            context_type: type,
            context_id: contextId,
            status: 'open',
            created_at: new Date('2026-10-25T10:00:00.000Z'),
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
    pool = {
      execute,
      getConnection: () => Promise.resolve(connection),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue(pool)
      .overrideProvider(AuthService)
      .useValue({
        validateAccessToken: (token: string) =>
          Promise.resolve(token === 'valid-token' ? 'token-user-id' : null),
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

  function submit(
    body: Record<string, unknown> = { username: 'target', reason: 'spam' },
  ) {
    return request(app.getHttpServer())
      .post('/reports')
      .set('Authorization', 'Bearer valid-token')
      .send(body);
  }

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .post('/reports')
      .send({ username: 'target', reason: 'spam' })
      .expect(401);
    expect(insertedReports).toHaveLength(0);
  });

  it('creates a report using token identity and returns only the reduced DTO', async () => {
    const response = await submit().expect(201);
    const body = response.body as {
      id: string;
      reported_username: string;
      reason: string;
      status: string;
      created_at: string;
    };

    expect(Object.keys(body).sort()).toEqual(
      ['id', 'reported_username', 'reason', 'status', 'created_at'].sort(),
    );
    expect(body).toMatchObject({
      reported_username: 'target',
      reason: 'spam',
      status: 'open',
      created_at: '2026-10-25T10:00:00.000Z',
    });
    expect(insertedReports).toHaveLength(1);
    expect(insertedReports[0].reporter_id).toBe('token-user-id');
    expect(insertedReports[0]).not.toHaveProperty('email');
    expect(rateLimitCalls.at(-1)).toMatchObject({
      path: '/reports',
      accountId: 'token-user-id',
    });
  });

  it('rejects unknown targets, self-reports, invalid context, and extra fields', async () => {
    await submit({ username: 'unknown_user', reason: 'spam' }).expect(404);
    await submit({ username: 'reporter', reason: 'spam' }).expect(400);
    await submit({
      username: 'target',
      reason: 'spam',
      context_type: 'post',
      context_id: 'missing-post',
    }).expect(404);
    await submit({
      username: 'target',
      reason: 'spam',
      context_type: 'comment',
      context_id: 'comment-1',
    }).expect(400);
    await submit({
      username: 'target',
      reason: 'spam',
      context_type: 'post',
    }).expect(400);
    await submit({
      username: 'target',
      reason: 'spam',
      reporter_id: 'another-user',
      status: 'resolved',
      resolution: 'user_banned',
    }).expect(400);

    expect(insertedReports).toHaveLength(0);
  });

  it('persists valid content context, detects duplicates, and permits later reports', async () => {
    const report = {
      username: 'target',
      reason: 'harassment',
      description: 'Repeated unwanted contact',
      context_type: 'post',
      context_id: 'post-1',
    };
    await submit(report).expect(201);
    expect(insertedReports[0]).toMatchObject({
      context_type: 'post',
      context_id: 'post-1',
      reason: 'harassment',
    });

    existingReports = [{ id: 'active-report', status: 'under_review' }];
    await submit(report).expect(409);

    existingReports = [{ id: 'resolved-report', status: 'resolved' }];
    await submit(report).expect(201);
    expect(insertedReports).toHaveLength(2);
  });

  it('rejects a limited submission with 429 and Retry-After', async () => {
    rateLimitRetry = 75;

    const response = await submit().expect(429);

    expect(response.headers['retry-after']).toBe('75');
    expect(insertedReports).toHaveLength(0);
  });
});
