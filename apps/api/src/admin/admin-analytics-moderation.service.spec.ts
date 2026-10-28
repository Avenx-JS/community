import { beforeEach, describe, expect, it } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import {
  executeAnalyticsQuery,
  FakeAnalyticsData,
  FakeReport,
} from '../../test/fakes/analytics-pool';
import { MYSQL_POOL } from '../auth/auth.service';
import { AdminAnalyticsService } from './admin-analytics.service';

const utc = (value: string) => new Date(value);
const range = (from: string, to: string) => ({ from: utc(from), to: utc(to) });
const NOW = utc('2026-10-23T09:14:02.000Z');
const october = range('2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z');

const report = (
  created_at: string,
  overrides: Partial<FakeReport> = {},
): FakeReport => ({
  reason: 'spam',
  status: 'open',
  resolution: null,
  created_at: utc(created_at),
  reviewed_at: null,
  ...overrides,
});

const decided = (
  created_at: string,
  reviewed_at: string,
  overrides: Partial<FakeReport> = {},
) =>
  report(created_at, {
    status: 'resolved',
    resolution: 'no_action',
    reviewed_at: utc(reviewed_at),
    ...overrides,
  });

describe('AdminAnalyticsService moderation metrics', () => {
  let service: AdminAnalyticsService;
  let data: FakeAnalyticsData & { reports: FakeReport[] };
  let calls: Array<{ sql: string; values: unknown[] }>;

  beforeEach(async () => {
    data = { users: [], restrictions: [], reports: [], now: NOW };
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

  it('issues six parameterised statements on separate time columns', async () => {
    await service.moderationMetrics(october, 'day', NOW);

    expect(calls).toHaveLength(6);
    const bounds = ['2026-10-01 00:00:00.000', '2026-10-08 00:00:00.000'];
    const [submitted, reviewed, backlog, oldest, applied, lifted] = calls;
    expect(submitted.sql).toContain(
      "created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
    );
    expect(submitted.sql).toContain('GROUP BY day_number, reason');
    expect(submitted.values).toEqual(bounds);
    expect(reviewed.sql).toContain(
      "reviewed_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
    );
    expect(reviewed.sql).toContain(
      "reviewed_at < CONVERT_TZ(?, '+00:00', @@session.time_zone)",
    );
    expect(reviewed.sql).toContain("status IN ('resolved', 'rejected')");
    expect(reviewed.sql).toContain(
      'UNIX_TIMESTAMP(reviewed_at) - UNIX_TIMESTAMP(created_at)',
    );
    expect(reviewed.values).toEqual(bounds);
    expect(backlog.sql).toBe(
      'SELECT status AS `key`, COUNT(*) AS total FROM user_reports GROUP BY status',
    );
    expect(backlog.values).toEqual([]);
    expect(oldest.sql).toContain("status IN ('open', 'under_review')");
    expect(oldest.sql).toContain(
      'UNIX_TIMESTAMP() - UNIX_TIMESTAMP(MIN(created_at))',
    );
    expect(oldest.values).toEqual([]);
    expect(applied.sql).toContain('GROUP BY type');
    expect(applied.values).toEqual(bounds);
    expect(lifted.sql).toContain(
      "lifted_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
    );
    expect(lifted.values).toEqual(bounds);
    for (const call of calls) {
      expect(call.sql).not.toMatch(
        /description|resolution_note|lift_reason|reporter_id|reported_user_id|username|email|password_hash|auth_/,
      );
    }
  });

  it('uses the same number of statements for any range length', async () => {
    await service.moderationMetrics(
      range('2026-10-22T00:00:00Z', '2026-10-23T00:00:00Z'),
      'day',
      NOW,
    );
    const short = calls.length;
    calls = [];
    await service.moderationMetrics(
      range('2025-10-23T00:00:00Z', '2026-10-23T00:00:00Z'),
      'week',
      NOW,
    );
    expect(calls).toHaveLength(short);
  });

  it('keeps submitted and reviewed populations apart across the boundary', async () => {
    data.reports = [
      // Submitted before the range, decided inside it.
      decided('2026-09-20T00:00:00Z', '2026-10-02T00:00:00Z'),
      // Submitted inside the range, decided after it.
      decided('2026-10-03T00:00:00Z', '2026-10-09T00:00:00Z'),
      // Submitted and decided inside it.
      decided('2026-10-04T00:00:00Z', '2026-10-04T06:00:00Z'),
    ];

    const result = await service.moderationMetrics(october, 'day', NOW);

    expect(result.totals.reports_submitted).toBe(2);
    expect(result.totals.reports_reviewed).toBe(2);
    expect(result.time_to_review_seconds).toEqual({
      average: Math.round((12 * 86_400 + 6 * 3_600) / 2),
      maximum: 12 * 86_400,
      count: 2,
    });
  });

  it('applies half-open bounds to created_at, reviewed_at and lifted_at', async () => {
    data.reports = [
      report('2026-09-30T23:59:59Z'),
      report('2026-10-01T00:00:00Z'),
      report('2026-10-07T23:59:59Z'),
      report('2026-10-08T00:00:00Z'),
      decided('2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z'),
      decided('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
      decided('2026-09-01T00:00:00Z', '2026-10-08T00:00:00Z'),
    ];
    const restriction = (lifted_at: string | null, created_at: string) => ({
      user_id: 'u',
      type: 'suspension' as const,
      created_at: utc(created_at),
      expires_at: utc('2026-12-01T00:00:00Z'),
      lifted_at: lifted_at === null ? null : utc(lifted_at),
    });
    data.restrictions = [
      restriction('2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z'),
      restriction('2026-10-08T00:00:00Z', '2026-10-01T00:00:00Z'),
      restriction('2026-09-30T23:59:59Z', '2026-09-30T23:59:59Z'),
    ];

    const result = await service.moderationMetrics(october, 'day', NOW);

    expect(result.totals.reports_submitted).toBe(2);
    expect(result.totals.reports_reviewed).toBe(1);
    expect(result.totals.restrictions_lifted).toBe(1);
    expect(result.restrictions_applied).toEqual({ suspension: 1, ban: 0 });
  });

  it('excludes unreviewed and merely triaged reports from reviewed metrics', async () => {
    data.reports = [
      report('2026-10-02T00:00:00Z'),
      report('2026-10-02T00:00:00Z', {
        status: 'under_review',
        reviewed_at: utc('2026-10-03T00:00:00Z'),
      }),
    ];

    const result = await service.moderationMetrics(october, 'day', NOW);

    expect(result.totals.reports_reviewed).toBe(0);
    expect(result.time_to_review_seconds).toEqual({
      average: null,
      maximum: null,
      count: 0,
    });
    expect(
      Object.values(result.resolutions_by_type).every((count) => count === 0),
    ).toBe(true);
  });

  it('groups outcomes with rejected reports in their own bucket', async () => {
    data.reports = [
      decided('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
      decided('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', {
        resolution: 'user_banned',
      }),
      decided('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', {
        resolution: 'user_banned',
      }),
      decided('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', {
        status: 'rejected',
        resolution: null,
      }),
    ];

    const result = await service.moderationMetrics(october, 'day', NOW);

    expect(result.resolutions_by_type).toEqual({
      no_action: 1,
      content_removed: 0,
      user_warned: 0,
      user_suspended: 0,
      user_banned: 2,
      rejected: 1,
    });
    expect(result.time_to_review_seconds.count).toBe(
      result.totals.reports_reviewed,
    );
  });

  it('returns enum-complete reason groups and a zero-filled series', async () => {
    data.reports = [
      report('2026-10-02T10:00:00Z', { reason: 'harassment' }),
      report('2026-10-02T11:00:00Z', { reason: 'spam' }),
      report('2026-10-05T00:00:00Z', { reason: 'spam' }),
    ];

    const result = await service.moderationMetrics(october, 'day', NOW);

    expect(result.reports_by_reason).toEqual({
      spam: 2,
      harassment: 1,
      hate_speech: 0,
      sexual_content: 0,
      self_harm: 0,
      impersonation: 0,
      other: 0,
    });
    expect(result.series.reports_submitted.map((point) => point.count)).toEqual(
      [0, 2, 0, 0, 1, 0, 0],
    );
  });

  it('fills an empty range and a single-day range', async () => {
    const empty = await service.moderationMetrics(october, 'day', NOW);
    expect(empty.series.reports_submitted).toHaveLength(7);
    expect(empty.totals.reports_submitted).toBe(0);

    data.reports = [report('2026-10-01T05:00:00Z')];
    const single = await service.moderationMetrics(
      range('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
      'day',
      NOW,
    );
    expect(single.series.reports_submitted).toEqual([
      { bucket: '2026-10-01', count: 1 },
    ]);
  });

  it('sums the weekly series across a year boundary', async () => {
    data.reports = [
      report('2026-12-30T00:00:00Z'),
      report('2027-01-02T00:00:00Z'),
      report('2027-01-04T00:00:00Z'),
    ];

    const result = await service.moderationMetrics(
      range('2026-12-28T00:00:00Z', '2027-01-11T00:00:00Z'),
      'week',
      NOW,
    );

    expect(result.series.reports_submitted).toEqual([
      { bucket: '2026-W53', count: 2 },
      { bucket: '2027-W01', count: 1 },
    ]);
    expect(result.totals.reports_submitted).toBe(3);
  });

  it('reports the backlog and oldest open age at the current moment only', async () => {
    data.reports = [
      report('2026-10-23T08:14:02Z'),
      report('2026-10-20T09:14:02Z', { status: 'under_review' }),
      decided('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
    ];

    const recent = await service.moderationMetrics(october, 'day', NOW);
    const old = await service.moderationMetrics(
      range('2025-01-01T00:00:00Z', '2025-02-01T00:00:00Z'),
      'day',
      NOW,
    );

    for (const result of [recent, old]) {
      expect(result.point_in_time).toEqual({
        backlog_by_status: {
          open: 1,
          under_review: 1,
          resolved: 1,
          rejected: 0,
        },
        oldest_open_report_age_seconds: 3 * 86_400,
      });
    }
  });

  it('returns a null oldest age when only decided reports exist', async () => {
    data.reports = [
      decided('2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z'),
      decided('2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', {
        status: 'rejected',
        resolution: null,
      }),
    ];

    const result = await service.moderationMetrics(october, 'day', NOW);

    expect(result.point_in_time.oldest_open_report_age_seconds).toBeNull();
    expect(result.point_in_time.backlog_by_status).toEqual({
      open: 0,
      under_review: 0,
      resolved: 1,
      rejected: 1,
    });
  });

  it('counts only lifted restrictions, not expired ones', async () => {
    data.restrictions = [
      {
        user_id: 'expired',
        type: 'suspension',
        created_at: utc('2026-09-01T00:00:00Z'),
        expires_at: utc('2026-10-03T00:00:00Z'),
        lifted_at: null,
      },
      {
        user_id: 'lifted',
        type: 'ban',
        created_at: utc('2026-09-01T00:00:00Z'),
        expires_at: null,
        lifted_at: utc('2026-10-03T00:00:00Z'),
      },
    ];

    const result = await service.moderationMetrics(october, 'day', NOW);

    expect(result.totals.restrictions_lifted).toBe(1);
  });

  it('labels every metric with its time column', async () => {
    const result = await service.moderationMetrics(october, 'day', NOW);

    expect(result.meta.time_basis).toMatchObject({
      reports_submitted: 'user_reports.created_at',
      reports_reviewed: 'user_reports.reviewed_at',
      time_to_review_seconds: 'user_reports.reviewed_at',
      restrictions_applied: 'user_restrictions.created_at',
      restrictions_lifted: 'user_restrictions.lifted_at',
      'point_in_time.backlog_by_status': 'point_in_time',
    });
  });
});
