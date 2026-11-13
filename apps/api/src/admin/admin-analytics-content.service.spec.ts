import { beforeEach, describe, expect, it } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import {
  ACTIVE_COMMUNITIES_SQL,
  AdminAnalyticsService,
  COMMUNITY_STATES_SQL,
  dailyCountSql,
  MEMBER_DISTRIBUTION_SQL,
  removalsBySourceSql,
} from './admin-analytics.service';

const DAY = 86_400_000;
const from = new Date('2026-11-01T00:00:00.000Z');
const to = new Date('2026-11-04T00:00:00.000Z');
const day = (date: Date) => Math.floor(date.getTime() / DAY);
const d1 = day(from);
const now = new Date('2026-11-13T12:00:00.000Z');

describe('AdminAnalyticsService content and community metrics', () => {
  let service: AdminAnalyticsService;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let answers: Map<string, unknown[]>;

  beforeEach(() => {
    calls = [];
    answers = new Map();
    service = new AdminAnalyticsService({
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve([answers.get(sql) ?? [], []]);
      },
    } as unknown as Pool);
  });

  it('counts posts, comments and votes per day, split by type, value and removal source', async () => {
    answers.set(dailyCountSql('posts', 'type'), [
      { day_number: d1, key: 'text', total: '2' },
      { day_number: d1, key: 'link', total: 1 },
      { day_number: d1 + 2, key: 'media', total: '4' },
    ]);
    answers.set(dailyCountSql('comments'), [
      { day_number: d1 + 1, total: '5' },
    ]);
    answers.set(
      dailyCountSql('votes', "CASE WHEN value > 0 THEN 'up' ELSE 'down' END"),
      [
        { day_number: d1, key: 'up', total: '7' },
        { day_number: d1, key: 'down', total: '2' },
      ],
    );
    answers.set(removalsBySourceSql('posts'), [
      { key: 'moderator', total: '3' },
      { key: 'admin', total: '1' },
    ]);
    answers.set(removalsBySourceSql('comments'), [
      { key: 'admin', total: '2' },
    ]);

    const result = await service.contentMetrics({ from, to }, 'day', now);

    expect(result.totals).toEqual({
      posts: 7,
      comments: 5,
      votes: 9,
      posts_removed: 4,
      comments_removed: 2,
    });
    expect(result.posts_by_type).toEqual({ text: 2, link: 1, media: 4 });
    expect(result.votes_by_value).toEqual({ up: 7, down: 2 });
    expect(result.removals_by_source).toEqual({ moderator: 3, admin: 3 });
    expect(result.series.posts).toEqual([
      { bucket: '2026-11-01', count: 3 },
      { bucket: '2026-11-02', count: 0 },
      { bucket: '2026-11-03', count: 4 },
    ]);
    expect(result.series.comments.map((point) => point.count)).toEqual([
      0, 5, 0,
    ]);
    expect(result.meta.time_basis.votes).toBe('votes.created_at');
    expect(result.generated_at).toBe(now.toISOString());
  });

  it('runs a fixed set of bound, grouped statements, never one row per item', async () => {
    await service.contentMetrics({ from, to }, 'week', now);
    await service.communityMetrics({ from, to }, 'week', now);

    expect(calls).toHaveLength(9);
    for (const { sql, values } of calls) {
      expect(sql).toMatch(/COUNT\(\*\)/);
      expect(sql).not.toMatch(
        /username|email|author_id|user_id AS|title|content AS/,
      );
      for (const value of values) {
        expect(String(value)).toMatch(/^2026-11-0[14] 00:00:00\.000$/);
      }
    }
    expect(
      calls.find(({ sql }) => sql === ACTIVE_COMMUNITIES_SQL)?.values,
    ).toHaveLength(4);
  });

  it('reports growth, activity, states and a zero-filled member distribution', async () => {
    answers.set(COMMUNITY_STATES_SQL, [
      { key: 'active', total: '10' },
      { key: 'suspended', total: '2' },
      { key: 'deleted', total: '3' },
    ]);
    answers.set(dailyCountSql('communities'), [
      { day_number: d1 + 1, total: '2' },
    ]);
    answers.set(ACTIVE_COMMUNITIES_SQL, [{ total: '6' }]);
    answers.set(MEMBER_DISTRIBUTION_SQL, [
      { key: '0', total: '4' },
      { key: '10-99', total: '7' },
      { key: '1000+', total: '1' },
    ]);

    const result = await service.communityMetrics({ from, to }, 'day', now);

    expect(result.totals).toEqual({
      total_communities: 12,
      new_communities: 2,
      active_communities: 6,
      suspended_communities: 2,
      deleted_communities: 3,
    });
    expect(result.members_distribution).toEqual({
      '0': 4,
      '1-9': 0,
      '10-99': 7,
      '100-999': 0,
      '1000+': 1,
    });
    expect(result.series.new_communities).toHaveLength(3);
    expect(result.meta.scopes.members_distribution).toBe('point_in_time');
  });

  it('buckets membership without naming a community', () => {
    expect(MEMBER_DISTRIBUTION_SQL).toMatch(/GROUP BY `key`$/);
    expect(MEMBER_DISTRIBUTION_SQL).not.toMatch(/SELECT[^(]*\bname\b/);
    expect(MEMBER_DISTRIBUTION_SQL).toContain('WHERE c.deleted_at IS NULL');
  });
});
