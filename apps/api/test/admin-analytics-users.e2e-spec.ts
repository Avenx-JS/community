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
} from './fakes/analytics-pool';

interface AnalyticsResponse {
  from: string;
  to: string;
  granularity: string;
  generated_at: string;
  totals: Record<string, number>;
  users_by_role: Record<string, number>;
  restrictions_applied: Record<string, number>;
  series: { new_users: Array<{ bucket: string; count: number }> };
  meta: {
    active_users_since: string | null;
    active_users_resolution_seconds: number;
    active_users_is_floor: boolean;
    scopes: Record<string, string>;
  };
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

describe('Admin user analytics API (e2e)', () => {
  let app: INestApplication<App>;
  let data: FakeAnalyticsData;
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
      users: [
        {
          role: 'admin',
          created_at: daysAgo(400),
          last_seen_at: daysAgo(0.01),
        },
        {
          role: 'moderator',
          created_at: daysAgo(100),
          last_seen_at: daysAgo(3),
        },
        { role: 'user', created_at: daysAgo(20), last_seen_at: daysAgo(40) },
        { role: 'user', created_at: daysAgo(10), last_seen_at: null },
        { role: 'user', created_at: daysAgo(10.2), last_seen_at: null },
      ],
      restrictions: [
        {
          user_id: 'banned',
          type: 'ban',
          created_at: daysAgo(5),
          expires_at: null,
          lifted_at: null,
        },
        {
          user_id: 'suspended',
          type: 'suspension',
          created_at: daysAgo(50),
          expires_at: daysAgo(-1),
          lifted_at: null,
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
    (await get(`/admin/analytics/users${query}`).expect(200))
      .body as AnalyticsResponse;

  it('requires an administrator and leaks no metrics on refusal', async () => {
    const responses = [
      await request(app.getHttpServer())
        .get('/admin/analytics/users')
        .expect(401),
      await get('/admin/analytics/users', 'user-token').expect(403),
      await get('/admin/analytics/users', 'moderator-token').expect(403),
    ];
    for (const response of responses) {
      expect(response.body).not.toHaveProperty('totals');
      expect(JSON.stringify(response.body)).not.toContain('total_users');
    }
    expect(analyticsStatements).toBe(0);
  });

  it('returns the documented shape for the default 30-day range', async () => {
    const body = await metrics();

    expect(Object.keys(body).sort()).toEqual(
      [
        'from',
        'generated_at',
        'granularity',
        'meta',
        'restrictions_applied',
        'series',
        'to',
        'totals',
        'users_by_role',
      ].sort(),
    );
    const from = Date.parse(body.from);
    const to = Date.parse(body.to);
    expect(to - from).toBe(30 * 86_400_000);
    expect(Math.abs(Date.parse(body.generated_at) - to)).toBeLessThan(5_000);
    expect(body.granularity).toBe('day');
    expect(body.totals).toEqual({
      total_users: 5,
      new_users: 3,
      active_users: 2,
      suspended_users: 1,
      banned_users: 1,
    });
    expect(body.users_by_role).toEqual({ user: 3, moderator: 1, admin: 1 });
    expect(body.restrictions_applied).toEqual({ suspension: 0, ban: 1 });
    expect(body.series.new_users.length).toBeGreaterThanOrEqual(30);
    expect(body.series.new_users.length).toBeLessThanOrEqual(31);
    expect(
      body.series.new_users.reduce((sum, point) => sum + point.count, 0),
    ).toBe(body.totals.new_users);
    expect(body.meta).toMatchObject({
      active_users_resolution_seconds: 300,
      active_users_is_floor: false,
    });
    expect(body.meta.active_users_since).not.toBeNull();
    expect(body.meta.scopes.suspended_users).toBe('point_in_time');
    expect(body.meta.scopes.new_users).toBe('range');
  });

  it('buckets by ISO week and flags a historical range as a floor', async () => {
    const body = await metrics(
      '?from=2025-12-01T00:00:00Z&to=2026-01-15T00:00:00Z&granularity=week',
    );

    expect(body.series.new_users[0].bucket).toBe('2025-W49');
    expect(body.series.new_users.at(-1)?.bucket).toBe('2026-W03');
    expect(body.series.new_users).toHaveLength(7);
    expect(body.meta.active_users_is_floor).toBe(true);
    expect(body.users_by_role).toEqual({ user: 3, moderator: 1, admin: 1 });
  });

  it('uses the same statement count for short and long ranges', async () => {
    await metrics('?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z');
    const short = analyticsStatements;
    analyticsStatements = 0;
    await metrics('?from=2025-01-01T00:00:00Z&to=2026-01-01T00:00:00Z');
    expect(analyticsStatements).toBe(short);
    expect(short).toBe(5);
  });

  it.each([
    '?from=2026-01-02T00:00:00Z&to=2026-01-02T00:00:00Z',
    '?from=2026-01-03T00:00:00Z&to=2026-01-02T00:00:00Z',
    '?from=2024-01-01T00:00:00Z&to=2025-01-02T00:00:00Z',
    '?from=2020-01-01T00:00:00Z',
    '?from=not-a-date',
    '?to=2026-02-30T00:00:00Z',
    '?granularity=month',
    '?unknown=1',
  ])('rejects %s with 400', async (query) => {
    await get(`/admin/analytics/users${query}`).expect(400);
    expect(analyticsStatements).toBe(0);
  });

  it('contains only aggregates', async () => {
    for (const query of ['', '?granularity=week']) {
      const body = await metrics(query);
      const keys = collectKeys(body);
      for (const forbidden of [
        'id',
        'user_id',
        'username',
        'email',
        'password_hash',
        'last_seen_at',
        'created_at',
      ]) {
        expect(keys).not.toContain(forbidden);
      }
      expect(JSON.stringify(body)).not.toMatch(
        /@|admin-id|user-id|banned"|suspended"/,
      );
    }
  });
});
