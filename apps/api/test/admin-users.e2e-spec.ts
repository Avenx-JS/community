import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import { UsersService } from '../src/users/users.service';
import type { PlatformRole } from '../src/users/users.service';

function expectNoSensitiveKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectNoSensitiveKeys);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      expect(key).not.toMatch(/email|password|token|session/i);
      expectNoSensitiveKeys(child);
    }
  }
}

describe('Admin users API (e2e)', () => {
  let app: INestApplication<App>;
  let poolCalls: Array<{ sql: string; values: unknown[] }>;
  let roles: Map<string, PlatformRole>;
  const user = {
    id: 'user-1',
    username: 'sample_user',
    role: 'user' as const,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    status: 'active' as const,
    restriction_expires_at: null,
    open_reports_against: 0,
  };

  beforeEach(async () => {
    poolCalls = [];
    roles = new Map([
      ['admin-id', 'admin'],
      ['member-id', 'user'],
    ]);
    const execute = (sql: string, values: unknown[]) => {
      poolCalls.push({ sql, values });
      if (sql.startsWith('SELECT COUNT(*) AS total')) {
        return Promise.resolve([[{ total: 1 }], []]);
      }
      if (sql.includes('AS posts_count')) {
        return Promise.resolve([
          [
            {
              posts_count: 0,
              comments_count: 0,
              votes_count: 0,
              communities_created: 0,
              subscriptions_count: 0,
              moderated_communities_count: 0,
            },
          ],
          [],
        ]);
      }
      if (sql.includes('AS reports_filed_count')) {
        return Promise.resolve([
          [
            {
              open: 0,
              under_review: 0,
              resolved: 0,
              rejected: 0,
              reports_filed_count: 0,
              active_restrictions: 0,
              restriction_history_count: 0,
            },
          ],
          [],
        ]);
      }
      if (sql.includes('report_counts.open_reports_against')) {
        const rows = sql.includes('WHERE u.id = ? LIMIT 1')
          ? values[0] === user.id
            ? [user]
            : []
          : [user];
        return Promise.resolve([rows, []]);
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({ execute })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessToken: (token: string) =>
          Promise.resolve(
            token === 'admin-token'
              ? 'admin-id'
              : token === 'member-token'
                ? 'member-id'
                : null,
          ),
      })
      .overrideProvider(UsersService)
      .useValue({
        getPlatformRole: (userId: string) =>
          Promise.resolve(roles.get(userId) ?? null),
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

  const adminRequest = (path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer admin-token');

  it('requires authentication and platform-admin authorization', async () => {
    await request(app.getHttpServer()).get('/admin/users').expect(401);
    await request(app.getHttpServer())
      .get('/admin/users')
      .set('Authorization', 'Bearer member-token')
      .expect(403);
    expect(poolCalls).toHaveLength(0);
    await adminRequest('/admin/users').expect(200);
  });

  it('returns a private-safe paginated list using two bounded queries', async () => {
    const response = await adminRequest('/admin/users?limit=100').expect(200);

    expect(response.body).toMatchObject({
      items: [
        {
          id: 'user-1',
          username: 'sample_user',
          role: 'user',
          status: 'active',
          restriction_expires_at: null,
          open_reports_against: 0,
        },
      ],
      page: 1,
      limit: 100,
      total: 1,
      filters: {
        search: null,
        role: null,
        status: null,
        from: null,
        to: null,
        sort: 'new',
      },
    });
    expectNoSensitiveKeys(response.body);
    expect(poolCalls).toHaveLength(2);
    expect(poolCalls[0].sql).toContain('LEFT JOIN');
    expect(poolCalls[0].sql).toContain(
      "SUM(status IN ('open', 'under_review'))",
    );
  });

  it('echoes and applies list filters including the derived status', async () => {
    const response = await adminRequest(
      '/admin/users?search=sample&role=user&status=active&from=2026-01-01T00%3A00%3A00Z&to=2026-02-01T00%3A00%3A00Z&sort=oldest&page=1&limit=5',
    ).expect(200);

    expect(response.body).toMatchObject({
      filters: {
        search: 'sample',
        role: 'user',
        status: 'active',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
        sort: 'oldest',
      },
    });
    expect(poolCalls[0].sql).toContain('restriction_state.user_id IS NULL');
    expect(poolCalls[1].sql).toContain('restriction_state.user_id IS NULL');
    expect(poolCalls[0].values).toEqual([
      '%sample%',
      'user',
      '2026-01-01 00:00:00',
      '2026-02-01 00:00:00',
      5,
      0,
    ]);
    expectNoSensitiveKeys(response.body);
  });

  it('returns detail counts, not-found and malformed-id responses', async () => {
    const detail = await adminRequest('/admin/users/user-1').expect(200);
    expect(detail.body).toMatchObject({
      id: 'user-1',
      last_seen_at: null,
      posts_count: 0,
      comments_count: 0,
      votes_count: 0,
      communities_created: 0,
      subscriptions_count: 0,
      moderated_communities_count: 0,
      reports_against: { open: 0, under_review: 0, resolved: 0, rejected: 0 },
      reports_filed_count: 0,
      restrictions: { active: 0, history_count: 0 },
    });
    expectNoSensitiveKeys(detail.body);
    await adminRequest('/admin/users/unknown').expect(404);
    await adminRequest('/admin/users/bad.id').expect(400);
    await adminRequest('/admin/users?unknown=value').expect(400);
    await adminRequest('/admin/users?status=invalid').expect(400);
  });
});
