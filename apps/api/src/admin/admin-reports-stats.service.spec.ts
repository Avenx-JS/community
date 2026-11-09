import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import {
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
} from '../reports/report.constants';
import {
  AdminReportsService,
  REPORT_QUEUE_STATS_SCOPES,
} from './admin-reports.service';
import type { AuditLogService } from './audit-log.service';
import type { NotificationsService } from '../notifications/notifications.service';

describe('AdminReportsService.queueStats', () => {
  let calls: Array<{ sql: string; values: unknown[] }>;
  let answers: Map<string, unknown[]>;
  let service: AdminReportsService;

  // Each statement is told apart by what it groups or filters on.
  const kindOf = (sql: string) =>
    sql.includes('GROUP BY status')
      ? 'status'
      : sql.includes('GROUP BY reason')
        ? 'reason'
        : sql.includes('GROUP BY target_type')
          ? 'target_type'
          : sql.includes('assigned_to IS NULL')
            ? 'unassigned'
            : sql.includes('assigned_to = ?')
              ? 'mine'
              : sql.includes('withdrawn_at IS NOT NULL')
                ? 'withdrawn'
                : sql.includes('ORDER BY created_at ASC LIMIT 1')
                  ? 'oldest'
                  : 'unknown';
  const call = (kind: string) => {
    const found = calls.filter(({ sql }) => kindOf(sql) === kind);
    expect(found).toHaveLength(1);
    return found[0];
  };
  const normalised = (kind: string) => call(kind).sql.replace(/\s+/g, ' ');

  beforeEach(() => {
    calls = [];
    answers = new Map();
    service = new AdminReportsService(
      {
        execute: (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          const kind = kindOf(sql);
          if (kind === 'unknown') {
            return Promise.reject(new Error(`Unexpected query: ${sql}`));
          }
          return Promise.resolve([answers.get(kind) ?? [], []]);
        },
        getConnection: () => Promise.reject(new Error('No transaction')),
      } as unknown as Pool,
      {} as AuditLogService,
      {} as NotificationsService,
    );
  });

  it('runs seven independent statements on the pool, one per figure', async () => {
    await service.queueStats('admin-id');
    expect(calls.map(({ sql }) => kindOf(sql)).sort()).toEqual(
      [
        'mine',
        'oldest',
        'reason',
        'status',
        'target_type',
        'unassigned',
        'withdrawn',
      ].sort(),
    );
    for (const { sql } of calls) {
      expect(sql).toMatch(/^SELECT .* FROM user_reports\b/s);
      expect(sql).not.toMatch(/\bJOIN\b|\(\s*SELECT/);
    }
  });

  it('applies the queue’s default visibility to every figure but withdrawn_open', async () => {
    await service.queueStats('admin-id');
    for (const kind of [
      'status',
      'reason',
      'target_type',
      'unassigned',
      'mine',
      'oldest',
    ]) {
      expect(normalised(kind)).toContain('withdrawn_at IS NULL');
    }
    expect(normalised('withdrawn')).toBe(
      "SELECT COUNT(*) AS total FROM user_reports WHERE status = 'open' AND withdrawn_at IS NOT NULL",
    );
  });

  it('builds each aggregate on its index-friendly predicate', async () => {
    await service.queueStats('admin-id');
    expect(normalised('status')).toBe(
      "SELECT status AS `key`, COUNT(*) AS total FROM user_reports WHERE status IN ('open', 'under_review') AND withdrawn_at IS NULL GROUP BY status",
    );
    expect(normalised('reason')).toBe(
      "SELECT reason AS `key`, COUNT(*) AS total FROM user_reports WHERE status = 'open' AND withdrawn_at IS NULL GROUP BY reason",
    );
    expect(normalised('target_type')).toBe(
      "SELECT target_type AS `key`, COUNT(*) AS total FROM user_reports WHERE status = 'open' AND withdrawn_at IS NULL GROUP BY target_type",
    );
    expect(normalised('unassigned')).toBe(
      "SELECT COUNT(*) AS total FROM user_reports WHERE assigned_to IS NULL AND status = 'open' AND withdrawn_at IS NULL",
    );
    expect(normalised('mine')).toBe(
      "SELECT COUNT(*) AS total FROM user_reports WHERE assigned_to = ? AND status = 'open' AND withdrawn_at IS NULL",
    );
    expect(normalised('oldest')).toBe(
      "SELECT created_at FROM user_reports WHERE status = 'open' AND withdrawn_at IS NULL ORDER BY created_at ASC LIMIT 1",
    );
  });

  it('binds only the caller id, and only to assigned_to_me_open', async () => {
    await service.queueStats('caller-id');
    expect(call('mine').values).toEqual(['caller-id']);
    for (const { sql, values } of calls) {
      if (kindOf(sql) !== 'mine') {
        expect(values).toEqual([]);
      }
    }
  });

  // The figures are what the table holds now: no "since", no window.
  it('computes no clock value or window boundary in JavaScript', async () => {
    const now = jest.spyOn(Date, 'now');
    await service.queueStats('admin-id');
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
    for (const { sql } of calls) {
      expect(sql).not.toMatch(/UTC_TIMESTAMP|NOW\(\)|INTERVAL|created_at [<>]/);
    }
  });

  it('answers an empty queue with zeros, full key maps and a null oldest_open_at', async () => {
    const stats = await service.queueStats('admin-id');
    expect(stats).toEqual({
      open: 0,
      under_review: 0,
      unassigned_open: 0,
      assigned_to_me_open: 0,
      withdrawn_open: 0,
      by_reason: Object.fromEntries(REPORT_REASONS.map((key) => [key, 0])),
      by_target_type: Object.fromEntries(
        REPORT_TARGET_TYPES.map((key) => [key, 0]),
      ),
      oldest_open_at: null,
      meta: { scopes: REPORT_QUEUE_STATS_SCOPES },
    });
    expect(stats).toHaveProperty('oldest_open_at', null);
  });

  it('maps the counts, fills absent keys with 0, and ignores unknown keys', async () => {
    answers.set('status', [
      { key: 'open', total: '5' },
      { key: 'under_review', total: 2 },
    ]);
    answers.set('reason', [
      { key: 'spam', total: 3 },
      { key: 'harassment', total: '2' },
      { key: 'not_a_reason', total: 9 },
    ]);
    answers.set('target_type', [
      { key: 'post', total: 4 },
      { key: 'user', total: 1 },
    ]);
    answers.set('unassigned', [{ total: '3' }]);
    answers.set('mine', [{ total: 1 }]);
    answers.set('withdrawn', [{ total: 2 }]);
    answers.set('oldest', [{ created_at: new Date('2026-10-20T08:00:00Z') }]);

    const stats = await service.queueStats('admin-id');
    expect(stats).toMatchObject({
      open: 5,
      under_review: 2,
      unassigned_open: 3,
      assigned_to_me_open: 1,
      withdrawn_open: 2,
      oldest_open_at: '2026-10-20T08:00:00.000Z',
    });
    expect(stats.by_reason).toEqual({
      spam: 3,
      harassment: 2,
      hate_speech: 0,
      sexual_content: 0,
      self_harm: 0,
      impersonation: 0,
      other: 0,
    });
    expect(stats.by_target_type).toEqual({
      user: 1,
      post: 4,
      comment: 0,
      community: 0,
    });
  });

  it('labels every figure point_in_time, and nothing else', async () => {
    const { meta, ...figures } = await service.queueStats('admin-id');
    expect(Object.keys(meta.scopes).sort()).toEqual(
      Object.keys(figures).sort(),
    );
    expect(new Set(Object.values(meta.scopes))).toEqual(
      new Set(['point_in_time']),
    );
  });
});
