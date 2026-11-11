import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  controversy,
  controversySql,
  HOT_DECAY_SECONDS,
  hotRank,
  hotRankSql,
  NEW_POST_HOT_RANK_SQL,
  NEW_POST_RISING_RANK_SQL,
  RANK_EPOCH_SECONDS,
  RECOMPUTE_COMMENT_RANKING_SQL,
  RECOMPUTE_POST_RANKING_SQL,
  RISING_DECAY_SECONDS,
  risingRank,
  risingRankSql,
} from './content-ranking';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const at = (iso: string) => new Date(iso);
const HOUR = 3600 * 1000;

describe('hot rank', () => {
  it('is fixed by score and creation time alone', () => {
    // 2024-01-02T00:00:00Z is 86,400 s after the epoch: 86400 / 45000.
    expect(hotRank(0, at('2024-01-02T00:00:00Z'))).toBeCloseTo(1.92, 10);
    expect(hotRank(100, at('2024-01-02T00:00:00Z'))).toBeCloseTo(3.92, 10);
    expect(hotRank(-100, at('2024-01-02T00:00:00Z'))).toBeCloseTo(-0.08, 10);
    expect(hotRank(1, at('2024-01-02T00:00:00Z'))).toBe(
      hotRank(0, at('2024-01-02T00:00:00Z')),
    );
  });

  it('weighs one order of magnitude of score as 12.5 hours of age', () => {
    const older = at('2026-11-01T00:00:00Z');
    const newer = new Date(older.getTime() + HOT_DECAY_SECONDS * 1000);
    expect(hotRank(10, older)).toBeCloseTo(hotRank(1, newer), 10);
    expect(hotRank(11, older)).toBeGreaterThan(hotRank(1, newer));
    expect(hotRank(9, older)).toBeLessThan(hotRank(1, newer));
  });

  it('ranks a higher score first at the same age, and a newer post first at the same score', () => {
    const created = at('2026-11-01T12:00:00Z');
    expect(hotRank(5, created)).toBeGreaterThan(hotRank(4, created));
    expect(hotRank(-4, created)).toBeGreaterThan(hotRank(-5, created));
    expect(hotRank(5, new Date(created.getTime() + 1000))).toBeGreaterThan(
      hotRank(5, created),
    );
  });

  it('ignores milliseconds, as UNIX_TIMESTAMP of a TIMESTAMP column does', () => {
    expect(hotRank(3, at('2026-11-01T12:00:00.999Z'))).toBe(
      hotRank(3, at('2026-11-01T12:00:00.000Z')),
    );
  });
});

describe('rising rank', () => {
  it('decays four times faster than hot', () => {
    expect(HOT_DECAY_SECONDS / RISING_DECAY_SECONDS).toBe(4);
    const older = at('2026-11-01T00:00:00Z');
    const newer = new Date(older.getTime() + RISING_DECAY_SECONDS * 1000);
    expect(risingRank(10, older)).toBeCloseTo(risingRank(1, newer), 10);
  });

  // Where hot and rising disagree: a post 6 hours old with score 30 against
  // a fresh one with score 3. Hot keeps the older (log10 30 - 6/12.5 = 0.997
  // > log10 3 = 0.477); rising prefers the fresh one
  // (1.477 - 6 / 3.125 = -0.443 < 0.477).
  it('surfaces a fresh post that hot still ranks below an older one', () => {
    const fresh = at('2026-11-01T18:00:00Z');
    const older = new Date(fresh.getTime() - 6 * HOUR);
    expect(hotRank(30, older)).toBeGreaterThan(hotRank(3, fresh));
    expect(risingRank(3, fresh)).toBeGreaterThan(risingRank(30, older));
  });
});

describe('controversy', () => {
  it('is 0 without both an up- and a downvote', () => {
    expect(controversy(0, 0)).toBe(0);
    expect(controversy(50, 0)).toBe(0);
    expect(controversy(0, 50)).toBe(0);
  });

  it('is the vote count raised to the minority share', () => {
    expect(controversy(5, 5)).toBe(10);
    expect(controversy(9, 1)).toBeCloseTo(Math.pow(10, 1 / 9), 12);
    expect(controversy(1, 9)).toBe(controversy(9, 1));
  });

  it('ranks an even split above a lopsided one, and more votes above fewer', () => {
    expect(controversy(5, 5)).toBeGreaterThan(controversy(9, 1));
    expect(controversy(10, 10)).toBeGreaterThan(controversy(5, 5));
    expect(controversy(6, 4)).toBeGreaterThan(controversy(7, 3));
  });
});

describe('the ranking SQL', () => {
  it('computes in DOUBLE, never DECIMAL', () => {
    expect(hotRankSql('score', 'x')).toBe(
      `SIGN(score) * LOG10(GREATEST(ABS(score), 1)) + (x - ${RANK_EPOCH_SECONDS}) / 45000e0`,
    );
    expect(risingRankSql('score', 'x')).toContain('/ 11250e0');
    expect(controversySql('u', 'd')).toContain('* 1e0 /');
  });

  it('gives a new post the ranks of score 0 now', () => {
    expect(NEW_POST_HOT_RANK_SQL).toBe(hotRankSql('0', 'UNIX_TIMESTAMP()'));
    expect(NEW_POST_RISING_RANK_SQL).toBe(
      risingRankSql('0', 'UNIX_TIMESTAMP()'),
    );
  });

  // Left to right, each assignment seeing the ones before it: the counts,
  // then the score from them, then the ranks from the score.
  it('recomputes a post from its votes, counts first', () => {
    const sql = normalise(RECOMPUTE_POST_RANKING_SQL);
    expect(sql).toMatch(
      /^UPDATE posts SET upvotes = .* downvotes = .* score = upvotes - downvotes, hot_rank = .* rising_rank = .* WHERE id = \?$/,
    );
    expect(sql).toContain(
      "upvotes = (SELECT COUNT(*) FROM votes WHERE target_type = 'post' AND target_id = ? AND value = 1)",
    );
    expect(sql).toContain(
      `hot_rank = ${hotRankSql('score', 'UNIX_TIMESTAMP(created_at)')}`,
    );
    expect(sql.match(/\?/g)).toHaveLength(3);
  });

  it('recomputes a comment from its votes, counts first', () => {
    const sql = normalise(RECOMPUTE_COMMENT_RANKING_SQL);
    expect(sql).toMatch(
      /^UPDATE comments SET upvotes = .* downvotes = .* score = upvotes - downvotes, controversy = .* WHERE id = \?$/,
    );
    expect(sql).toContain("target_type = 'comment'");
    expect(sql).toContain(
      `controversy = ${controversySql('upvotes', 'downvotes')}`,
    );
    expect(sql.match(/\?/g)).toHaveLength(3);
  });
});

describe('migration 034 (content ranking)', () => {
  const migration = normalise(
    read('../../../../data/migrations/034_add_content_ranking.sql').replace(
      /^--.*$/gm,
      '',
    ),
  );
  const snapshot = normalise(read('../../../../data/community.sql'));
  const INDEXES = [
    'CREATE INDEX idx_posts_hot ON posts (hot_rank, id);',
    'CREATE INDEX idx_posts_top ON posts (score, id);',
    'CREATE INDEX idx_posts_created ON posts (created_at, id);',
  ];

  // The backfill and the vote path must rank alike, or a post's rank would
  // jump on its first vote after the migration.
  it('backfills with the exact expressions the vote path uses', () => {
    expect(migration).toContain(
      `hot_rank = ${hotRankSql('score', 'UNIX_TIMESTAMP(created_at)')},`,
    );
    expect(migration).toContain(
      `rising_rank = ${risingRankSql('score', 'UNIX_TIMESTAMP(created_at)')};`,
    );
    expect(migration).toContain(
      `controversy = ${controversySql('upvotes', 'downvotes')};`,
    );
    expect(migration).toContain(
      "upvotes = (SELECT COUNT(*) FROM votes WHERE target_type = 'post' AND target_id = posts.id AND value = 1)",
    );
    expect(migration).toContain(
      "downvotes = (SELECT COUNT(*) FROM votes WHERE target_type = 'comment' AND target_id = comments.id AND value = -1)",
    );
  });

  it('adds the columns before the backfill, and the indexes after it', () => {
    const backfill = migration.indexOf('UPDATE posts SET');
    expect(migration.indexOf('ALTER TABLE posts')).toBeLessThan(backfill);
    expect(migration.indexOf('ALTER TABLE comments')).toBeLessThan(backfill);
    for (const index of INDEXES) {
      expect(migration.indexOf(index)).toBeGreaterThan(backfill);
    }
  });

  it('declares identical columns and indexes in the snapshot and records the version', () => {
    for (const column of [
      'upvotes INT NOT NULL DEFAULT 0',
      'downvotes INT NOT NULL DEFAULT 0',
      'score INT NOT NULL DEFAULT 0',
      'hot_rank DOUBLE NOT NULL DEFAULT 0',
      'rising_rank DOUBLE NOT NULL DEFAULT 0',
    ]) {
      expect(migration).toContain(`ADD COLUMN ${column}`);
      expect(snapshot).toMatch(
        new RegExp(
          `CREATE TABLE posts \\([^;]*${column.replace(/[()]/g, '\\$&')}`,
        ),
      );
    }
    expect(snapshot).toMatch(
      /CREATE TABLE comments \([^;]*controversy DOUBLE NOT NULL DEFAULT 0/,
    );
    for (const index of INDEXES) {
      expect(snapshot).toContain(index);
    }
    expect(snapshot).toContain(
      "('033_add_communities_created_index'), ('034_add_content_ranking');",
    );
  });

  it('states re-run safety', () => {
    expect(
      read('../../../../data/migrations/034_add_content_ranking.sql'),
    ).toMatch(/Not safely re-runnable after partial application/);
  });
});
