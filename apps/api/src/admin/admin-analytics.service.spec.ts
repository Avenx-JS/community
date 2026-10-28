import { beforeEach, describe, expect, it } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import {
  executeAnalyticsQuery,
  FakeAnalyticsData,
} from '../../test/fakes/analytics-pool';
import { MYSQL_POOL } from '../auth/auth.service';
import { ACTIVE_USER_RESTRICTION_PREDICATE } from '../common/active-user-restriction';
import {
  AdminAnalyticsService,
  isActiveUsersFloor,
} from './admin-analytics.service';

const utc = (value: string) => new Date(value);
const range = (from: string, to: string) => ({ from: utc(from), to: utc(to) });
const NOW = utc('2026-10-23T09:14:02.000Z');

describe('AdminAnalyticsService', () => {
  let service: AdminAnalyticsService;
  let data: FakeAnalyticsData;
  let calls: Array<{ sql: string; values: unknown[] }>;

  beforeEach(async () => {
    data = { users: [], restrictions: [], now: NOW };
    calls = [];
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        const result = executeAnalyticsQuery(data, sql, values);
        if (!result) throw new Error(`Unexpected query: ${sql}`);
        return result;
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminAnalyticsService,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();

    service = module.get(AdminAnalyticsService);
  });

  const user = (
    created_at: string,
    overrides: Partial<FakeAnalyticsData['users'][0]> = {},
  ) => ({
    role: 'user' as const,
    created_at: utc(created_at),
    last_seen_at: null,
    ...overrides,
  });

  it('issues five parameterised statements with the range bounds', async () => {
    await service.userMetrics(
      range('2026-09-23T00:00:00Z', '2026-10-23T00:00:00.500Z'),
      'day',
      NOW,
    );

    expect(calls).toHaveLength(5);
    const bounds = ['2026-09-23 00:00:00.000', '2026-10-23 00:00:00.500'];
    const [roles, series, active, restrictions, applied] = calls;
    expect(roles.sql).toBe(
      'SELECT role AS `key`, COUNT(*) AS total FROM users GROUP BY role',
    );
    expect(roles.values).toEqual([]);
    expect(series.sql).toContain('FLOOR(UNIX_TIMESTAMP(created_at) / 86400)');
    expect(series.sql).toContain(
      "created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
    );
    expect(series.sql).toContain(
      "created_at < CONVERT_TZ(?, '+00:00', @@session.time_zone)",
    );
    expect(series.values).toEqual(bounds);
    expect(active.sql).toContain(
      "last_seen_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
    );
    expect(active.sql).toContain('(SELECT MIN(last_seen_at) FROM users)');
    expect(active.values).toEqual(bounds);
    expect(restrictions.sql).toContain(ACTIVE_USER_RESTRICTION_PREDICATE);
    expect(restrictions.sql).toContain(
      "COUNT(DISTINCT CASE WHEN type = 'suspension' THEN user_id END)",
    );
    expect(restrictions.sql).toContain(
      "COUNT(DISTINCT CASE WHEN type = 'ban' THEN user_id END)",
    );
    expect(restrictions.values).toEqual([]);
    expect(applied.sql).toContain('GROUP BY type');
    expect(applied.values).toEqual(bounds);
    for (const call of calls) {
      expect(call.sql).not.toMatch(
        /email|password_hash|auth_sessions|auth_refresh_tokens|auth_rate_limits|username/,
      );
    }
  });

  it('uses the same number of statements for any range length', async () => {
    await service.userMetrics(
      range('2026-10-22T00:00:00Z', '2026-10-23T00:00:00Z'),
      'day',
      NOW,
    );
    const short = calls.length;
    calls = [];
    await service.userMetrics(
      range('2025-10-22T00:00:00Z', '2026-10-22T00:00:00Z'),
      'week',
      NOW,
    );
    expect(calls).toHaveLength(short);
  });

  it('counts registrations over a half-open interval', async () => {
    data.users = [
      user('2026-09-30T23:59:59Z'),
      user('2026-10-01T00:00:00Z'),
      user('2026-10-02T12:00:00Z'),
      user('2026-10-03T23:59:59Z'),
      user('2026-10-04T00:00:00Z'),
    ];

    const result = await service.userMetrics(
      range('2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z'),
      'day',
      NOW,
    );

    expect(result.totals.new_users).toBe(3);
    expect(result.series.new_users).toEqual([
      { bucket: '2026-10-01', count: 1 },
      { bucket: '2026-10-02', count: 1 },
      { bucket: '2026-10-03', count: 1 },
    ]);
    expect(result.totals.total_users).toBe(5);
  });

  it('zero-fills gaps and sums the weekly series to new_users', async () => {
    data.users = [
      user('2026-12-28T10:00:00Z'),
      user('2027-01-02T10:00:00Z'),
      user('2027-01-05T10:00:00Z'),
    ];
    const window = range('2026-12-21T00:00:00Z', '2027-01-18T00:00:00Z');

    const daily = await service.userMetrics(window, 'day', NOW);
    const weekly = await service.userMetrics(window, 'week', NOW);

    expect(daily.series.new_users).toHaveLength(28);
    expect(
      daily.series.new_users.filter((point) => point.count > 0),
    ).toHaveLength(3);
    expect(weekly.series.new_users).toEqual([
      { bucket: '2026-W52', count: 0 },
      { bucket: '2026-W53', count: 2 },
      { bucket: '2027-W01', count: 1 },
      { bucket: '2027-W02', count: 0 },
    ]);
    for (const result of [daily, weekly]) {
      expect(
        result.series.new_users.reduce((sum, point) => sum + point.count, 0),
      ).toBe(result.totals.new_users);
    }
  });

  it('keeps point-in-time metrics independent of the range', async () => {
    data.users = [
      user('2025-01-01T00:00:00Z', { role: 'admin' }),
      user('2026-10-10T00:00:00Z', { role: 'moderator' }),
      user('2026-10-11T00:00:00Z'),
    ];
    data.restrictions = [
      {
        user_id: 'a',
        type: 'ban',
        created_at: utc('2025-01-01T00:00:00Z'),
        expires_at: null,
        lifted_at: null,
      },
    ];

    const recent = await service.userMetrics(
      range('2026-10-01T00:00:00Z', '2026-10-20T00:00:00Z'),
      'day',
      NOW,
    );
    const old = await service.userMetrics(
      range('2024-12-01T00:00:00Z', '2025-02-01T00:00:00Z'),
      'day',
      NOW,
    );

    for (const result of [recent, old]) {
      expect(result.totals.total_users).toBe(3);
      expect(result.users_by_role).toEqual({ user: 1, moderator: 1, admin: 1 });
      expect(result.totals.banned_users).toBe(1);
    }
    expect(recent.totals.new_users).toBe(2);
    expect(old.totals.new_users).toBe(1);
    expect(recent.restrictions_applied).toEqual({ suspension: 0, ban: 0 });
    expect(old.restrictions_applied).toEqual({ suspension: 0, ban: 1 });
  });

  it('zero-fills roles that have no accounts', async () => {
    data.users = [user('2026-10-01T00:00:00Z')];

    const result = await service.userMetrics(
      range('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
      'day',
      NOW,
    );

    expect(result.users_by_role).toEqual({ user: 1, moderator: 0, admin: 0 });
  });

  it('counts each restricted account once and ignores expired or lifted rows', async () => {
    const restriction = (
      user_id: string,
      type: 'suspension' | 'ban',
      overrides: Partial<FakeAnalyticsData['restrictions'][0]> = {},
    ) => ({
      user_id,
      type,
      created_at: utc('2026-10-10T00:00:00Z'),
      expires_at: type === 'ban' ? null : utc('2026-11-01T00:00:00Z'),
      lifted_at: null,
      ...overrides,
    });
    data.restrictions = [
      restriction('dup', 'suspension'),
      restriction('dup', 'suspension'),
      restriction('other', 'suspension'),
      restriction('expired', 'suspension', {
        expires_at: utc('2026-10-23T09:14:01Z'),
      }),
      restriction('lifted', 'ban', { lifted_at: utc('2026-10-12T00:00:00Z') }),
      restriction('banned', 'ban'),
    ];

    const result = await service.userMetrics(
      range('2026-10-01T00:00:00Z', '2026-10-20T00:00:00Z'),
      'day',
      NOW,
    );

    expect(result.totals.suspended_users).toBe(2);
    expect(result.totals.banned_users).toBe(1);
    expect(result.restrictions_applied).toEqual({ suspension: 4, ban: 2 });
  });

  it('counts active users by last_seen_at and excludes never-seen accounts', async () => {
    data.users = [
      user('2026-01-01T00:00:00Z', {
        last_seen_at: utc('2026-10-01T08:12:00Z'),
      }),
      user('2026-01-01T00:00:00Z', {
        last_seen_at: utc('2026-10-22T00:00:00Z'),
      }),
      user('2026-01-01T00:00:00Z', {
        last_seen_at: utc('2026-10-23T09:14:02Z'),
      }),
      user('2026-01-01T00:00:00Z'),
    ];

    const result = await service.userMetrics(
      range('2026-10-02T00:00:00Z', '2026-10-23T09:14:02Z'),
      'day',
      NOW,
    );

    expect(result.totals.active_users).toBe(1);
    expect(result.meta).toMatchObject({
      active_users_since: '2026-10-01T08:12:00.000Z',
      active_users_resolution_seconds: 300,
      active_users_is_floor: false,
    });
  });

  it('labels every metric with its scope', async () => {
    const result = await service.userMetrics(
      range('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
      'day',
      NOW,
    );

    expect(result.meta.scopes).toMatchObject({
      total_users: 'point_in_time',
      suspended_users: 'point_in_time',
      banned_users: 'point_in_time',
      users_by_role: 'point_in_time',
      new_users: 'range',
      active_users: 'range',
      restrictions_applied: 'range',
    });
    expect(result).toMatchObject({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      granularity: 'day',
      generated_at: NOW.toISOString(),
    });
  });
});

describe('isActiveUsersFloor', () => {
  const since = utc('2026-10-01T08:12:00Z');

  it('is a floor without any recorded activity', () => {
    expect(
      isActiveUsersFloor(
        range('2026-10-02T00:00:00Z', NOW.toISOString()),
        null,
        NOW,
        300,
      ),
    ).toBe(true);
  });

  it('is a floor when the range starts before collection began', () => {
    expect(
      isActiveUsersFloor(
        range('2026-10-01T08:11:59Z', NOW.toISOString()),
        since,
        NOW,
        300,
      ),
    ).toBe(true);
    expect(
      isActiveUsersFloor(
        range('2026-10-01T08:12:00Z', NOW.toISOString()),
        since,
        NOW,
        300,
      ),
    ).toBe(false);
  });

  it('is a floor when the range ends in the past beyond the resolution', () => {
    expect(
      isActiveUsersFloor(
        range('2026-10-02T00:00:00Z', '2026-10-23T09:09:02Z'),
        since,
        NOW,
        300,
      ),
    ).toBe(false);
    expect(
      isActiveUsersFloor(
        range('2026-10-02T00:00:00Z', '2026-10-23T09:09:01Z'),
        since,
        NOW,
        300,
      ),
    ).toBe(true);
  });
});
