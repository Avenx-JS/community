import { describe, expect, it, beforeEach } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  MEMBERS_JOIN,
  MEMBERS_WHERE,
  MODERATORS_FROM,
} from './communities.service';
import {
  COMMENT_STATS_SQL,
  CommunityStatsService,
  MEMBER_COUNT_SQL,
  MODERATOR_COUNT_SQL,
  POST_STATS_SQL,
  WINDOW_START,
} from './community-stats.service';

const community = {
  id: 'community-1',
  creator_id: 'creator-id',
  created_at: new Date('2026-01-14T09:12:00.000Z'),
};

describe('CommunityStatsService', () => {
  let service: CommunityStatsService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let answers: Map<string, unknown[]>;

  beforeEach(async () => {
    queries = [];
    answers = new Map();
    // Answers by statement, since the aggregates run concurrently.
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        const rows = sql.startsWith('SELECT id, creator_id, created_at')
          ? answers.get('community')
          : answers.get(sql);
        return Promise.resolve([rows ?? [], []]);
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityStatsService,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();
    service = module.get(CommunityStatsService);
  });

  it('resolves the community once by name and binds every aggregate to its id', async () => {
    answers.set('community', [community]);

    await service.get('gardening');

    expect(queries[0]).toEqual({
      sql: 'SELECT id, creator_id, created_at FROM communities WHERE name = ? AND deleted_at IS NULL AND suspended_at IS NULL LIMIT 1',
      values: ['gardening'],
    });
    expect(queries.slice(1)).toEqual([
      { sql: MEMBER_COUNT_SQL, values: ['community-1'] },
      { sql: MODERATOR_COUNT_SQL, values: ['community-1', 'creator-id'] },
      { sql: POST_STATS_SQL, values: ['community-1'] },
      { sql: COMMENT_STATS_SQL, values: ['community-1'] },
    ]);
    for (const { sql, values } of queries.slice(1)) {
      expect(sql).not.toContain('gardening');
      expect(values).not.toContain('gardening');
    }
  });

  it('counts members and moderators exactly as the lists do', () => {
    expect(MEMBER_COUNT_SQL).toBe(
      `SELECT COUNT(*) AS total ${MEMBERS_JOIN} WHERE ${MEMBERS_WHERE}`,
    );
    expect(MODERATOR_COUNT_SQL).toBe(
      `SELECT COUNT(*) AS total ${MODERATORS_FROM}`,
    );
  });

  it('expresses the seven-day windows in SQL on the database clock', () => {
    const normalised = WINDOW_START.replace(/\s+/g, ' ');
    expect(normalised).toBe(
      "CONVERT_TZ( DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY), '+00:00', @@session.time_zone )",
    );
    expect(POST_STATS_SQL).toContain(`SUM(created_at >= ${WINDOW_START})`);
    expect(COMMENT_STATS_SQL).toContain(`SUM(c.created_at >= ${WINDOW_START})`);
    // Nothing time-related is bound from the application clock.
    for (const sql of [POST_STATS_SQL, COMMENT_STATS_SQL]) {
      expect(sql.match(/\?/g)).toHaveLength(1);
      expect(sql).not.toMatch(/NOW\(\)|CURRENT_TIMESTAMP/);
    }
  });

  it('reads every post figure from one statement and joins comments through posts', () => {
    expect(POST_STATS_SQL).toMatch(
      /COUNT\(\*\) AS total,\s+MAX\(created_at\) AS last_post_at,[\s\S]+FROM posts\s+WHERE community_id = \? AND removed_at IS NULL$/,
    );
    expect(COMMENT_STATS_SQL).toMatch(
      /FROM posts p\s+JOIN comments c ON c.post_id = p.id\s+WHERE p.community_id = \?\s+AND p.removed_at IS NULL\s+AND c.removed_at IS NULL$/,
    );
  });

  it('maps the populated counts, converting strings and dates', async () => {
    answers.set('community', [community]);
    answers.set(MEMBER_COUNT_SQL, [{ total: 1280 }]);
    answers.set(MODERATOR_COUNT_SQL, [{ total: '3' }]);
    answers.set(POST_STATS_SQL, [
      {
        total: 4120,
        last_post_at: new Date('2026-10-31T18:04:11.000Z'),
        recent: '86',
      },
    ]);
    answers.set(COMMENT_STATS_SQL, [{ total: '19873', recent: '412' }]);

    await expect(service.get('gardening')).resolves.toEqual({
      member_count: 1280,
      moderator_count: 3,
      post_count: 4120,
      comment_count: 19873,
      created_at: '2026-01-14T09:12:00.000Z',
      last_post_at: '2026-10-31T18:04:11.000Z',
      posts_last_7_days: 86,
      comments_last_7_days: 412,
    });
  });

  it('returns zeros and a present null last_post_at for an empty community', async () => {
    answers.set('community', [community]);
    answers.set(MEMBER_COUNT_SQL, [{ total: 0 }]);
    answers.set(MODERATOR_COUNT_SQL, [{ total: 0 }]);
    answers.set(POST_STATS_SQL, [
      { total: 0, last_post_at: null, recent: '0' },
    ]);
    answers.set(COMMENT_STATS_SQL, [{ total: 0, recent: '0' }]);

    const stats = await service.get('gardening');

    expect(stats).toEqual({
      member_count: 0,
      moderator_count: 0,
      post_count: 0,
      comment_count: 0,
      created_at: '2026-01-14T09:12:00.000Z',
      last_post_at: null,
      posts_last_7_days: 0,
      comments_last_7_days: 0,
    });
    expect(Object.keys(stats)).toContain('last_post_at');
  });

  it('answers 404 for an unknown or deleted community without aggregating', async () => {
    await expect(service.get('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(queries).toHaveLength(1);
  });
});
