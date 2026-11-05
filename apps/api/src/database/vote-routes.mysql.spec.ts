import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createConnection,
  createPool,
  type Connection,
  type Pool,
  type RowDataPacket,
} from 'mysql2/promise';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { voteScoresSql } from '../votes/vote-scores';
import { OWN_VOTE_SQL, SCORE_SQL, VotesService } from '../votes/votes.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The vote routes and the scores on content responses against a real MySQL
// server: withdrawal, the caller's-own-vote read, the per-page scores, and
// the plans that justify not storing a score column: the single-target
// aggregate and the per-page grouped aggregate read idx_votes_target alone
// (Using index), and the own-vote lookup is a const read of
// unique_user_target. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_*
// credentials that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('vote routes and content scores (MySQL)', () => {
  const database = `vote_routes_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let votes: VotesService;
  let posts: PostsService;
  // Rule acceptance is covered elsewhere; here every vote is accepted.
  const accepting = {
    assertAcceptedOrThrow: () => Promise.resolve(),
  } as unknown as CommunityRuleAcceptanceService;

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };
  const explain = (sql: string, values: unknown[]) =>
    rows(`EXPLAIN ${sql}`, values);

  beforeAll(async () => {
    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${snapshot}`,
    );
    // 50 users, 200 posts, 200 comments; every user votes on every post
    // and comment, value alternating by user and target, so the table is
    // large enough that a scan would show in the plans.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50)
        SELECT CONCAT('u', n), CONCAT('u', n), CONCAT('u', n, '@example.test'), 'x' FROM seq;
      INSERT INTO communities (id, creator_id, name) VALUES ('c1', 'u1', 'one');
      INSERT INTO posts (id, title, content, author_id, community_id, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
        SELECT CONCAT('p', n), CONCAT('Post ', n), 'Body', 'u1', 'c1',
               TIMESTAMP('2026-01-01 00:00:00') + INTERVAL n MINUTE
        FROM seq;
      INSERT INTO comments (id, post_id, author_id, content)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
        SELECT CONCAT('m', n), 'p1', 'u1', 'Comment' FROM seq;
      INSERT INTO votes (id, user_id, target_type, target_id, value)
        SELECT UUID(), users.id, 'post', posts.id,
               IF((CAST(SUBSTRING(users.id, 2) AS UNSIGNED) + CAST(SUBSTRING(posts.id, 2) AS UNSIGNED)) % 3 = 0, -1, 1)
        FROM users CROSS JOIN posts;
      INSERT INTO votes (id, user_id, target_type, target_id, value)
        SELECT UUID(), users.id, 'comment', comments.id,
               IF(CAST(SUBSTRING(users.id, 2) AS UNSIGNED) % 2 = 0, -1, 1)
        FROM users CROSS JOIN comments;
      -- p-unvoted and the new users u-fresh have no votes at all.
      INSERT INTO posts (id, title, content, author_id, community_id)
        VALUES ('p-unvoted', 'Unvoted', 'Body', 'u1', 'c1');
      INSERT INTO users (id, username, email, password_hash)
        VALUES ('u-fresh', 'u_fresh', 'fresh@example.test', 'x'),
               ('u-other', 'u_other', 'other@example.test', 'x');
      ANALYZE TABLE votes, posts, comments, users, communities;`);

    pool = createPool({ ...credentials, database, connectionLimit: 3 });
    votes = new VotesService(pool, accepting);
    posts = new PostsService(
      pool,
      {} as NotificationsService,
      accepting,
      {} as CommunityModerationLogService,
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  const storedScore = async (targetType: string, targetId: string) =>
    Number(
      (
        await rows(
          'SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE target_type = ? AND target_id = ?',
          [targetType, targetId],
        )
      )[0].score,
    );
  const voteRows = (userId: string, targetId: string) =>
    rows('SELECT value FROM votes WHERE user_id = ? AND target_id = ?', [
      userId,
      targetId,
    ]);

  it('votes, repeats, withdraws idempotently and re-votes with consistent scores', async () => {
    const base = await storedScore('post', 'p-unvoted');
    expect(base).toBe(0);

    const cast = await votes.vote(
      { target_type: 'post', target_id: 'p-unvoted', value: 1 },
      'u-fresh',
    );
    expect(cast).toMatchObject({ value: 1, score: 1 });
    const repeated = await votes.vote(
      { target_type: 'post', target_id: 'p-unvoted', value: 1 },
      'u-fresh',
    );
    expect(repeated).toEqual(cast);
    expect(await voteRows('u-fresh', 'p-unvoted')).toHaveLength(1);

    await votes.vote(
      { target_type: 'post', target_id: 'p-unvoted', value: -1 },
      'u-other',
    );
    await expect(votes.state('post', 'p-unvoted', 'u-fresh')).resolves.toEqual({
      value: 1,
      score: 0,
    });

    await expect(
      votes.withdraw('post', 'p-unvoted', 'u-fresh'),
    ).resolves.toEqual({ score: -1 });
    expect(await voteRows('u-fresh', 'p-unvoted')).toHaveLength(0);
    await expect(
      votes.withdraw('post', 'p-unvoted', 'u-fresh'),
    ).resolves.toEqual({ score: -1 });
    await expect(votes.state('post', 'p-unvoted', 'u-fresh')).resolves.toEqual({
      value: null,
      score: -1,
    });
    // u-other's vote is never reported as u-fresh's.
    await expect(votes.state('post', 'p-unvoted', 'u-other')).resolves.toEqual({
      value: -1,
      score: -1,
    });

    await votes.withdraw('post', 'p-unvoted', 'u-other');
    expect(await storedScore('post', 'p-unvoted')).toBe(0);
  });

  it('answers 404 for unknown targets on every route', async () => {
    for (const call of [
      () => votes.withdraw('post', 'no-such-post', 'u1'),
      () => votes.state('post', 'no-such-post', 'u1'),
      () => votes.withdraw('comment', 'no-such-comment', 'u1'),
      () => votes.state('comment', 'no-such-comment', 'u1'),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
    }
  });

  it('puts the stored score on every post of a page, 0 for an unvoted post', async () => {
    const page = await posts.findAll({ limit: 100 });
    expect(page.items[0]).toMatchObject({ id: 'p-unvoted', score: 0 });
    const expected = await rows(
      `SELECT target_id, SUM(value) AS score FROM votes
       WHERE target_type = 'post' GROUP BY target_id`,
    );
    const byId = new Map(
      expected.map((row) => [String(row.target_id), Number(row.score)]),
    );
    for (const post of page.items) {
      expect(post.score).toBe(byId.get(post.id) ?? 0);
    }
  });

  // Measured plans. The covering index is what makes the per-page aggregate
  // cheap enough not to store a score column (see the README).
  it('plans the single-target score as a ref on idx_votes_target, Using index', async () => {
    const plan = await explain(SCORE_SQL, ['post', 'p7']);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ type: 'ref', key: 'idx_votes_target' });
    expect(String(plan[0].Extra)).toContain('Using index');
  });

  it('plans the per-page grouped scores as a range on idx_votes_target, Using index, no temporary or filesort', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `p${index + 1}`);
    const plan = await explain(voteScoresSql(ids.length), ['post', ...ids]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ type: 'range', key: 'idx_votes_target' });
    const extra = String(plan[0].Extra);
    expect(extra).toContain('Using index');
    expect(extra).not.toContain('Using temporary');
    expect(extra).not.toContain('Using filesort');
  });

  it("plans the caller's own vote as a const read of unique_user_target", async () => {
    const plan = await explain(OWN_VOTE_SQL, ['u7', 'post', 'p7']);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ type: 'const', key: 'unique_user_target' });
  });
});
