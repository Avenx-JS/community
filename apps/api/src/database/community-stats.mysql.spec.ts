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
import {
  COMMENT_STATS_SQL,
  CommunityStatsService,
  MEMBER_COUNT_SQL,
  MODERATOR_COUNT_SQL,
  POST_STATS_SQL,
} from '../communities/community-stats.service';
import { runSqlScript } from './sql-script';

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Plans every aggregate of GET /communities/:name/stats on a real MySQL
// server, over enough rows that a scan is never the cheaper plan: an index
// that exists but is not chosen is not a fix. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and
// drop a scratch database; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community stats (MySQL)', () => {
  const database = `community_stats_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let service: CommunityStatsService;
  const issued: { sql: string; values: unknown[] }[] = [];

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };

  // The plan rows of the aggregate the service issued, keyed by table alias.
  const planOf = async (sql: string) => {
    const statement = issued.find((entry) => entry.sql === sql);
    expect(statement).toBeDefined();
    const plan = await rows(`EXPLAIN ${statement!.sql}`, statement!.values);
    for (const row of plan) {
      expect([row.table, row.type]).not.toEqual([row.table, 'ALL']);
    }
    return Object.fromEntries(plan.map((row) => [row.table as string, row]));
  };

  beforeAll(async () => {
    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${snapshot}`,
    );

    // 2000 users, 20 communities, 4000 posts and 8000 comments, spread so
    // that one community holds a few percent of each table.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
        SELECT CONCAT('u', n), CONCAT('user_', n), CONCAT('u', n, '@example.test'), 'x'
        FROM seq;
      INSERT INTO communities (id, creator_id, name)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20)
        SELECT CONCAT('c', n), 'u1', CONCAT('c', n) FROM seq;
      INSERT INTO communities (id, creator_id, name) VALUES ('empty', 'u1', 'empty');
      INSERT INTO community_subscriptions (user_id, community_id)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
        SELECT CONCAT('u', n), CONCAT('c', 1 + n % 20) FROM seq;
      INSERT INTO community_moderators (community_id, user_id, assigned_by)
        VALUES ('c1', 'u20', 'u1'), ('c1', 'u40', 'u1'), ('c1', 'u1', 'u1');
      INSERT INTO posts (id, title, content, author_id, community_id, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 4000)
        SELECT CONCAT('p', n), 'Post', 'Body', CONCAT('u', 1 + n % 2000),
               CONCAT('c', 1 + n % 20),
               TIMESTAMP('2025-01-01 00:00:00') + INTERVAL n HOUR
        FROM seq;
      INSERT INTO comments (id, post_id, author_id, content, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 8000)
        SELECT CONCAT('m', n), CONCAT('p', 1 + n % 4000),
               CONCAT('u', 1 + n % 2000), 'Comment',
               TIMESTAMP('2025-01-01 00:00:00') + INTERVAL n HOUR
        FROM seq;
      ANALYZE TABLE users, communities, community_subscriptions,
        community_moderators, posts, comments;`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    const recording = {
      execute: (sql: string, values: unknown[]) => {
        issued.push({ sql, values });
        return pool.execute(sql, values as never);
      },
    };
    service = new CommunityStatsService(recording as unknown as Pool);
    await service.get('c1');
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('counts members from the community-leading subscriptions index', async () => {
    const plan = await planOf(MEMBER_COUNT_SQL);
    expect(plan.s.key).toBe('idx_community_subscriptions_community_created');
    expect(plan.u.key).toBe('PRIMARY');
  });

  // Either index of community_moderators answers the count from the index
  // alone (the secondary one carries the primary-key columns); with three
  // rows MySQL 8.0.46 picks the secondary one. planOf rules out a scan.
  it('counts moderators from a community_moderators index alone', async () => {
    const plan = await planOf(MODERATOR_COUNT_SQL);
    expect(['PRIMARY', 'idx_community_moderators_user_id']).toContain(
      plan.m.key,
    );
    expect(String(plan.m.Extra)).toContain('Using index');
    expect(plan.u.key).toBe('PRIMARY');
  });

  it('reads every post figure from idx_posts_community_created alone', async () => {
    const plan = await planOf(POST_STATS_SQL);
    expect(plan.posts.key).toBe('idx_posts_community_created');
    expect(String(plan.posts.Extra)).toContain('Using index');
  });

  // The posts side needs only community_id and id, so any community_id-led
  // index covers it; since 026 MySQL prefers the narrower
  // idx_posts_community_pinned (community_id, pinned_at, + id).
  it('joins comments through the community posts on the listing indexes', async () => {
    const plan = await planOf(COMMENT_STATS_SQL);
    expect(String(plan.p.key)).toMatch(
      /^idx_posts_community_(created|pinned)$/,
    );
    expect(String(plan.p.Extra)).toContain('Using index');
    expect(plan.c.key).toBe('idx_comments_post_created');
  });

  it('matches direct counts and treats the creator as the lists do', async () => {
    const stats = await service.get('c1');
    const [expected] = await rows(`SELECT
      (SELECT COUNT(*) FROM community_subscriptions WHERE community_id = 'c1') AS members,
      (SELECT COUNT(*) FROM posts WHERE community_id = 'c1') AS posts,
      (SELECT COUNT(*) FROM comments c JOIN posts p ON p.id = c.post_id
         WHERE p.community_id = 'c1') AS comments,
      (SELECT MAX(created_at) FROM posts WHERE community_id = 'c1') AS last_post_at`);

    expect(stats).toMatchObject({
      member_count: Number(expected.members),
      // u20 and u40; the creator's self-appointment is not counted.
      moderator_count: 2,
      post_count: Number(expected.posts),
      comment_count: Number(expected.comments),
      last_post_at: (expected.last_post_at as Date).toISOString(),
    });
  });

  it('returns zeros and null for an empty community', async () => {
    await expect(service.get('empty')).resolves.toMatchObject({
      member_count: 0,
      moderator_count: 0,
      post_count: 0,
      comment_count: 0,
      last_post_at: null,
      posts_last_7_days: 0,
      comments_last_7_days: 0,
    });
  });

  it('bounds the seven-day window on the database clock in any session time zone', async () => {
    await connection.query(`
      INSERT INTO communities (id, creator_id, name) VALUES ('w', 'u1', 'window');
      INSERT INTO posts (id, title, content, author_id, community_id, created_at) VALUES
        ('w-in', 'In', 'x', 'u1', 'w', NOW() - INTERVAL 6 DAY - INTERVAL 23 HOUR),
        ('w-out', 'Out', 'x', 'u1', 'w', NOW() - INTERVAL 7 DAY - INTERVAL 1 HOUR);
      INSERT INTO comments (id, post_id, author_id, content, created_at) VALUES
        ('wc-in', 'w-in', 'u1', 'x', NOW() - INTERVAL 1 DAY),
        ('wc-out', 'w-out', 'u1', 'x', NOW() - INTERVAL 8 DAY);`);

    for (const zone of ['+00:00', '+05:00', '-08:00']) {
      const zoned = createPool({
        ...credentials,
        database,
        connectionLimit: 1,
        timezone: 'Z',
      });
      zoned.on('connection', (conn) => {
        conn.query(`SET time_zone = '${zone}'`);
      });
      try {
        const stats = await new CommunityStatsService(zoned).get('window');
        expect([
          zone,
          stats.posts_last_7_days,
          stats.comments_last_7_days,
        ]).toEqual([zone, 1, 1]);
      } finally {
        await zoned.end();
      }
    }
  });
});
