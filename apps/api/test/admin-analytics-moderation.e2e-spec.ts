import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import { createHash } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { MYSQL_POOL } from '../src/auth/auth.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import type { PlatformRole } from '../src/users/users.service';
import {
  executeAnalyticsQuery,
  FakeAnalyticsData,
  FakeReport,
} from './fakes/analytics-pool';

interface ModerationResponse {
  from: string;
  to: string;
  granularity: string;
  generated_at: string;
  totals: Record<string, number>;
  point_in_time: {
    backlog_by_status: Record<string, number>;
    oldest_open_report_age_seconds: number | null;
  };
  reports_by_reason: Record<string, number>;
  resolutions_by_type: Record<string, number>;
  time_to_review_seconds: {
    average: number | null;
    maximum: number | null;
    count: number;
  };
  restrictions_applied: Record<string, number>;
  series: { reports_submitted: Array<{ bucket: string; count: number }> };
  meta: { time_basis: Record<string, string> };
}

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, keys));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

describe('Admin moderation analytics API (e2e)', () => {
  let app: INestApplication<App>;
  let data: FakeAnalyticsData & { reports: FakeReport[] };
  let analyticsStatements: number;

  beforeEach(async () => {
    const roles = new Map<string, PlatformRole>([
      ['admin-id', 'admin'],
      ['moderator-id', 'moderator'],
      ['user-id', 'user'],
    ]);
    const sessions = new Map([
      [hashToken('admin-token'), 'admin-id'],
      [hashToken('moderator-token'), 'moderator-id'],
      [hashToken('user-token'), 'user-id'],
    ]);
    const now = new Date();
    const daysAgo = (days: number) =>
      new Date(now.getTime() - days * 86_400_000);
    data = {
      now,
      users: [],
      restrictions: [
        {
          user_id: 'banned-user',
          type: 'ban',
          created_at: daysAgo(5),
          expires_at: null,
          lifted_at: null,
        },
        {
          user_id: 'lifted-user',
          type: 'suspension',
          created_at: daysAgo(60),
          expires_at: daysAgo(-10),
          lifted_at: daysAgo(2),
        },
      ],
      reports: [
        {
          reason: 'harassment',
          status: 'open',
          resolution: null,
          created_at: daysAgo(4),
          reviewed_at: null,
        },
        {
          reason: 'spam',
          status: 'resolved',
          resolution: 'user_banned',
          created_at: daysAgo(45),
          reviewed_at: daysAgo(5),
        },
        {
          reason: 'spam',
          status: 'rejected',
          resolution: null,
          created_at: daysAgo(3),
          reviewed_at: daysAgo(2),
        },
      ],
    };
    analyticsStatements = 0;

    const result = (value: unknown) =>
      Promise.resolve([value, []] as [unknown, unknown]);
    const execute = (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT auth_sessions.user_id AS id')) {
        const userId = sessions.get(String(values[0]));
        return result(
          userId
            ? [
                {
                  id: userId,
                  restriction_type: null,
                  restriction_expires_at: null,
                },
              ]
            : [],
        );
      }
      if (sql.includes('SET last_seen_at = UTC_TIMESTAMP()')) {
        return result({ affectedRows: 1 });
      }
      if (sql === 'SELECT role FROM users WHERE id = ? LIMIT 1') {
        const role = roles.get(String(values[0]));
        return result(role ? [{ role }] : []);
      }
      const analytics = executeAnalyticsQuery(data, sql, values);
      if (analytics) {
        analyticsStatements += 1;
        return analytics;
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({ execute })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
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

  const get = (path: string, token = 'admin-token') =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`);
  const metrics = async (query = '') =>
    (await get(`/admin/analytics/moderation${query}`).expect(200))
      .body as ModerationResponse;

  it('requires an administrator and leaks no metrics on refusal', async () => {
    const responses = [
      await request(app.getHttpServer())
        .get('/admin/analytics/moderation')
        .expect(401),
      await get('/admin/analytics/moderation', 'user-token').expect(403),
      await get('/admin/analytics/moderation', 'moderator-token').expect(403),
    ];
    for (const response of responses) {
      expect(response.body).not.toHaveProperty('totals');
      expect(JSON.stringify(response.body)).not.toContain('reports_submitted');
    }
    expect(analyticsStatements).toBe(0);
  });

  it('returns the documented shape with separate totals and point_in_time', async () => {
    const body = await metrics();

    expect(Object.keys(body).sort()).toEqual(
      [
        'from',
        'generated_at',
        'granularity',
        'meta',
        'point_in_time',
        'reports_by_reason',
        'resolutions_by_type',
        'restrictions_applied',
        'series',
        'time_to_review_seconds',
        'to',
        'totals',
      ].sort(),
    );
    expect(Date.parse(body.to) - Date.parse(body.from)).toBe(30 * 86_400_000);
    expect(body.totals).toEqual({
      reports_submitted: 2,
      reports_reviewed: 2,
      restrictions_lifted: 1,
    });
    expect(body.point_in_time.backlog_by_status).toEqual({
      open: 1,
      under_review: 0,
      resolved: 1,
      rejected: 1,
    });
    expect(body.point_in_time.oldest_open_report_age_seconds).toBeGreaterThan(
      4 * 86_400 - 5,
    );
    expect(body.reports_by_reason).toMatchObject({
      harassment: 1,
      spam: 1,
      hate_speech: 0,
    });
    expect(Object.keys(body.reports_by_reason)).toHaveLength(7);
    expect(body.resolutions_by_type).toEqual({
      no_action: 0,
      content_removed: 0,
      user_warned: 0,
      user_suspended: 0,
      user_banned: 1,
      rejected: 1,
    });
    expect(body.time_to_review_seconds.count).toBe(2);
    expect(body.time_to_review_seconds.maximum).toBe(40 * 86_400);
    expect(body.restrictions_applied).toEqual({ suspension: 0, ban: 1 });
    expect(
      body.series.reports_submitted.reduce(
        (sum, point) => sum + point.count,
        0,
      ),
    ).toBe(body.totals.reports_submitted);
    expect(body.meta.time_basis.reports_reviewed).toBe(
      'user_reports.reviewed_at',
    );
  });

  it('keeps point-in-time figures fixed when the range moves', async () => {
    const current = await metrics();
    const historical = await metrics(
      '?from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z&granularity=week',
    );

    expect(historical.point_in_time).toEqual(current.point_in_time);
    expect(historical.totals).toEqual({
      reports_submitted: 0,
      reports_reviewed: 0,
      restrictions_lifted: 0,
    });
    expect(historical.time_to_review_seconds).toEqual({
      average: null,
      maximum: null,
      count: 0,
    });
    expect(historical.series.reports_submitted[0].bucket).toBe('2025-W01');
  });

  it('uses the same statement count for short and long ranges', async () => {
    await metrics('?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z');
    const short = analyticsStatements;
    analyticsStatements = 0;
    await metrics('?from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z');
    expect(analyticsStatements).toBe(short);
    expect(short).toBe(6);
  });

  it.each([
    '?from=2026-01-02T00:00:00Z&to=2026-01-02T00:00:00Z',
    '?from=2026-01-03T00:00:00Z&to=2026-01-02T00:00:00Z',
    '?from=2024-01-01T00:00:00Z&to=2025-01-02T00:00:00Z',
    '?from=not-a-date',
    '?granularity=month',
    '?unknown=1',
  ])('rejects %s with 400', async (query) => {
    await get(`/admin/analytics/moderation${query}`).expect(400);
    expect(analyticsStatements).toBe(0);
  });

  it('contains only aggregates, with no identities, text or rankings', async () => {
    for (const query of ['', '?granularity=week']) {
      const body = await metrics(query);
      const keys = collectKeys(body);
      for (const forbidden of [
        'id',
        'user_id',
        'report_id',
        'reporter_id',
        'reported_user_id',
        'username',
        'reporter_username',
        'reported_username',
        'email',
        'description',
        'resolution_note',
        'lift_reason',
        'reason',
        'note',
      ]) {
        expect(keys).not.toContain(forbidden);
      }
      expect(JSON.stringify(body)).not.toMatch(
        /@|admin-id|banned-user|lifted-user|top_|most_/,
      );
      const arrays = Object.values(body).filter(Array.isArray);
      expect(arrays).toHaveLength(0);
    }
  });
});
