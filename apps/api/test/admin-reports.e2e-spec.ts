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

interface ReportFixture {
  id: string;
  reporter_username: string | null;
  reported_username: string;
  reason: string;
  status: string;
  resolution: string | null;
  context_type: 'post' | 'comment' | null;
  context_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

interface AdminListResponse {
  items: ReportFixture[];
  total: number;
  filters: Record<string, unknown>;
}

interface AdminDetailResponse {
  reporter_username: string | null;
  reviewed_by_username: string | null;
  context: Record<string, unknown> | null;
  open_reports_against_user: number;
  total_reports_against_user: number;
  prior_resolutions_against_user: Array<{
    resolution: string;
    total: number;
  }>;
}

describe('Admin reports API (e2e)', () => {
  let app: INestApplication<App>;
  let reports: ReportFixture[];
  let roles: Map<string, PlatformRole>;
  let poolCalls: Array<{ sql: string; values: unknown[] }>;
  let detailHasContext: boolean;

  beforeEach(async () => {
    reports = Array.from({ length: 25 }, (_, index) => ({
      id: `report-${String(index + 1).padStart(2, '0')}`,
      reporter_username: index === 0 ? null : `reporter_${index}`,
      reported_username: index % 2 === 0 ? 'target_user' : 'other_target',
      reason: index % 2 === 0 ? 'spam' : 'harassment',
      status: index < 12 ? 'open' : 'resolved',
      resolution: index < 12 ? null : 'no_action',
      context_type: index === 0 ? 'post' : null,
      context_id: index === 0 ? 'deleted-post' : null,
      created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      reviewed_at: null,
    }));
    roles = new Map([
      ['admin-id', 'admin'],
      ['user-id', 'user'],
    ]);
    poolCalls = [];
    detailHasContext = false;

    const matchingReports = (sql: string, values: unknown[]) => {
      const where = sql.includes(' WHERE ')
        ? sql.slice(
            sql.indexOf(' WHERE '),
            sql.includes(' ORDER BY') ? sql.indexOf(' ORDER BY') : sql.length,
          )
        : '';
      let parameter = 0;
      let result = reports;
      const conditions = [
        [
          'ur.status = ?',
          (row: ReportFixture, value: unknown) => row.status === value,
        ],
        [
          'ur.reason = ?',
          (row: ReportFixture, value: unknown) => row.reason === value,
        ],
        [
          'reported_user.username = ?',
          (row: ReportFixture, value: unknown) =>
            row.reported_username === value,
        ],
        [
          'reporter_user.username = ?',
          (row: ReportFixture, value: unknown) =>
            row.reporter_username === value,
        ],
      ] as const;
      for (const [condition, matches] of conditions) {
        if (where.includes(condition)) {
          const value = values[parameter++];
          result = result.filter((row) => matches(row, value));
        }
      }
      const fromCondition =
        "ur.created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)";
      if (where.includes(fromCondition)) {
        const from = new Date(
          String(values[parameter++]).replace(' ', 'T') + 'Z',
        );
        result = result.filter((row) => new Date(row.created_at) >= from);
      }
      const toCondition =
        "ur.created_at < CONVERT_TZ(?, '+00:00', @@session.time_zone)";
      if (where.includes(toCondition)) {
        const to = new Date(
          String(values[parameter++]).replace(' ', 'T') + 'Z',
        );
        result = result.filter((row) => new Date(row.created_at) < to);
      }
      return result;
    };

    const execute = (sql: string, values: unknown[]) => {
      poolCalls.push({ sql, values });
      if (
        sql.startsWith('SELECT ur.id, reporter_user.username') &&
        !sql.includes('ur.description')
      ) {
        let result = matchingReports(sql, values);
        const direction = sql.includes('ur.created_at ASC') ? 1 : -1;
        result = [...result].sort(
          (left, right) =>
            direction *
            (left.created_at.localeCompare(right.created_at) ||
              left.id.localeCompare(right.id)),
        );
        const limit = Number(values[values.length - 2]);
        const offset = Number(values[values.length - 1]);
        return Promise.resolve([result.slice(offset, offset + limit), []] as [
          unknown,
          unknown,
        ]);
      }
      if (sql.startsWith('SELECT COUNT(*) AS total')) {
        return Promise.resolve([
          [{ total: matchingReports(sql, values).length }],
          [],
        ] as [unknown, unknown]);
      }
      if (
        sql.startsWith('SELECT ur.id, reporter_user.username') &&
        sql.includes('ur.description')
      ) {
        const report = reports.find((row) => row.id === values[0]);
        return Promise.resolve([
          report
            ? [
                {
                  ...report,
                  reporter_id: report.reporter_username ? 'reporter-id' : null,
                  reported_user_id: 'target-id',
                  description: 'Accusation detail',
                  resolution_note: null,
                  reviewed_by_username: null,
                },
              ]
            : [],
          [],
        ] as [unknown, unknown]);
      }
      if (sql.startsWith('SELECT context.title')) {
        return Promise.resolve([
          detailHasContext
            ? [
                {
                  title: 'Post title',
                  content: 'Context body',
                  author_username: 'target_user',
                },
              ]
            : [],
          [],
        ] as [unknown, unknown]);
      }
      if (sql.includes('AS open_reports_against_user')) {
        return Promise.resolve([
          [{ open_reports_against_user: 12, total_reports_against_user: 25 }],
          [],
        ] as [unknown, unknown]);
      }
      if (sql.startsWith('SELECT resolution, COUNT(*)')) {
        return Promise.resolve([
          [{ resolution: 'no_action', total: 10 }],
          [],
        ] as [unknown, unknown]);
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
              : token === 'user-token'
                ? 'user-id'
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

  it('enforces authentication and admin authorization', async () => {
    await request(app.getHttpServer()).get('/admin/reports').expect(401);
    await request(app.getHttpServer())
      .get('/admin/reports')
      .set('Authorization', 'Bearer user-token')
      .expect(403);
    await adminRequest('/admin/reports').expect(200);
  });

  it('paginates with stable order and applies every supported filter', async () => {
    const first = await adminRequest('/admin/reports?limit=10&page=1').expect(
      200,
    );
    const second = await adminRequest('/admin/reports?limit=10&page=2').expect(
      200,
    );
    const third = await adminRequest('/admin/reports?limit=10&page=3').expect(
      200,
    );
    const firstBody = first.body as AdminListResponse;
    const secondBody = second.body as AdminListResponse;
    const thirdBody = third.body as AdminListResponse;
    expect(firstBody.items).toHaveLength(10);
    expect(secondBody.items).toHaveLength(10);
    expect(thirdBody.items).toHaveLength(5);
    expect(firstBody.items[0].id).toBe('report-25');
    expect(
      new Set(
        [...firstBody.items, ...secondBody.items, ...thirdBody.items].map(
          (item) => item.id,
        ),
      ).size,
    ).toBe(25);
    expect(thirdBody.items[4].reporter_username).toBeNull();

    const filtered = await adminRequest(
      '/admin/reports?status=open&reason=spam&reported_username=target_user&reporter_username=reporter_2&from=2026-01-01T00%3A00%3A00Z&to=2026-01-10T00%3A00%3A00Z',
    ).expect(200);
    const filteredBody = filtered.body as AdminListResponse;
    expect(filteredBody.items).toHaveLength(1);
    expect(filteredBody.items[0].id).toBe('report-03');
    expect(filteredBody.total).toBe(1);
    expect(filteredBody.filters).toMatchObject({
      status: 'open',
      reason: 'spam',
      reported_username: 'target_user',
      reporter_username: 'reporter_2',
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-10T00:00:00Z',
    });
    expect(poolCalls.some((call) => call.sql.includes('ur.created_at <'))).toBe(
      true,
    );

    const halfOpen = await adminRequest(
      '/admin/reports?from=2026-01-01T00%3A00%3A00Z&to=2026-01-10T00%3A00%3A00Z',
    ).expect(200);
    expect((halfOpen.body as AdminListResponse).total).toBe(9);
  });

  it('rejects invalid filters, pagination, dates, and unknown query fields', async () => {
    for (const query of [
      '?page=0',
      '?limit=101',
      '?status=unknown',
      '?reason=unknown',
      '?from=nope',
      '?other=value',
    ]) {
      await adminRequest(`/admin/reports${query}`).expect(400);
    }
  });

  it('returns filtered list items without sensitive user data and bounds list queries', async () => {
    const response = await adminRequest(
      '/admin/reports?reporter_username=reporter_2&sort=oldest',
    ).expect(200);
    const body = response.body as AdminListResponse;
    expect(
      body.items.every((item) => item.reporter_username === 'reporter_2'),
    ).toBe(true);
    expect(
      poolCalls.filter((call) =>
        call.sql.startsWith('SELECT ur.id, reporter_user.username'),
      ),
    ).toHaveLength(1);
    expect(
      poolCalls.filter((call) =>
        call.sql.startsWith('SELECT COUNT(*) AS total'),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('email');
    expect(JSON.stringify(body)).not.toContain('password_hash');
  });

  it('returns null reporter, dangling context, triage aggregates, and 404 for unknown IDs', async () => {
    const response = await adminRequest('/admin/reports/report-01').expect(200);
    const body = response.body as AdminDetailResponse;
    expect(body.reporter_username).toBeNull();
    expect(body.reviewed_by_username).toBeNull();
    expect(body.context).toEqual({
      type: 'post',
      id: 'deleted-post',
      exists: false,
      title: null,
      content_excerpt: null,
      author_username: null,
    });
    expect(body).toMatchObject({
      open_reports_against_user: 12,
      total_reports_against_user: 25,
      prior_resolutions_against_user: [{ resolution: 'no_action', total: 10 }],
    });
    expect(JSON.stringify(body)).not.toContain('email');
    expect(JSON.stringify(body)).not.toContain('password_hash');
    await adminRequest('/admin/reports/missing-id').expect(404);
    await adminRequest('/admin/reports/bad.id').expect(400);
  });
});
