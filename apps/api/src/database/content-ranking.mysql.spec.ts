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
  CommentsService,
  commentListOrder,
} from '../comments/comments.service';
import { controversy, hotRank, risingRank } from '../common/content-ranking';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationsService } from '../notifications/notifications.service';
import type {
  PostListSort,
  PostTopWindow,
} from '../posts/dto/post-listing-query.dto';
import {
  POST_COLUMNS,
  postListingOrder,
  postListingWhere,
  PostsService,
  type PostListScope,
} from '../posts/posts.service';
import { VotesService } from '../votes/votes.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '034_add_content_ranking';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 034 undone: the counter and rank columns, the three
// indexes and the version.
const preceding = snapshot
  .replace(/ {4}(upvotes|downvotes|score) INT NOT NULL DEFAULT 0,\r?\n/g, '')
  .replace(
    / {4}(hot_rank|rising_rank|controversy) DOUBLE NOT NULL DEFAULT 0,\r?\n/g,
    '',
  )
  .replace(
    /-- Ranked listings \(034_add_content_ranking\)\.\r?\n(CREATE INDEX idx_posts_(hot|top|created) [^\n]*\n){3}/,
    '',
  )
  .replace(/,\r?\n\s*\('034_add_content_ranking'\)/, '');

// Migration 034 through the real runner over a database at 033 that already
// holds votes, then the vote path, the listings and their plans on the
// migrated database. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_*
// credentials that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('content ranking (MySQL)', () => {
  const database = `content_ranking_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  const accepting = {
    assertAcceptedOrThrow: () => Promise.resolve(),
  } as unknown as CommunityRuleAcceptanceService;
  let connection: Connection;
  let pool: Pool;
  let posts: PostsService;
  let comments: CommentsService;
  let votes: VotesService;
  let firstRun: string[];
  let secondRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const migrate = async () => {
    const runner: MigrationConnection = {
      execute: async (sql, values) => {
        const [result, fields] = await connection.execute(sql, values);
        return [result, fields];
      },
      query: async (sql) => {
        const [result, fields] = await connection.query(sql);
        return [result, fields];
      },
      end: () => Promise.resolve(),
    };
    const log: string[] = [];
    await runMigrations(runner, await loadMigrations(migrations), (line) =>
      log.push(line),
    );
    return log.filter((line) => !line.startsWith('Skipped'));
  };
  const schema = async (name: string) => ({
    columns: await rows(
      `SELECT table_name AS t, column_name AS name, column_type AS type,
              is_nullable AS nullable, column_default AS def
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name IN ('posts', 'comments')
       ORDER BY table_name, column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT table_name AS t, index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name IN ('posts', 'comments')
       GROUP BY table_name, index_name ORDER BY table_name, index_name`,
      [name],
    ),
  });
  const stored = async (table: 'posts' | 'comments', id: string) =>
    (await rows(`SELECT * FROM ${table} WHERE id = ?`, [id]))[0];
  // Plans of the statements the listing path issues.
  const explain = async (
    scope: PostListScope,
    sort: PostListSort,
    time?: PostTopWindow,
  ) => {
    const { where, values } = postListingWhere(scope, sort, time);
    return rows(
      `EXPLAIN SELECT ${POST_COLUMNS} FROM posts${where} ${postListingOrder(scope, sort)} LIMIT ? OFFSET ?`,
      [...values, 20, 0],
    );
  };
  const postsRow = (plan: RowDataPacket[]) =>
    plan.find((row) => row.table === 'posts')!;

  beforeAll(async () => {
    expect(preceding).not.toMatch(
      /upvotes|downvotes|hot_rank|rising_rank|controversy|idx_posts_hot/,
    );
    expect(preceding).not.toContain(VERSION);

    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${fresh}; USE ${fresh}; ${snapshot}`,
    );
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${preceding}`,
    );
    // At 033: content with votes, so the backfill has something to count.
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('author', 'author', 'author@example.test', 'x'),
        ('reader', 'reader', 'reader@example.test', 'x'),
        ('pest', 'pest', 'pest@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c-a', 'author', 'garden'),
        ('c-b', 'author', 'kitchen'),
        ('c-hidden', 'author', 'hidden'),
        ('c-banned', 'author', 'banned');
      INSERT INTO posts (id, title, content, author_id, community_id, created_at) VALUES
        ('p-voted', 'Voted', 'Body', 'author', 'c-a', '2026-11-01 10:00:00'),
        ('p-quiet', 'Quiet', 'Body', 'author', 'c-a', '2026-11-02 10:00:00');
      INSERT INTO comments (id, post_id, author_id, content) VALUES
        ('m-split', 'p-voted', 'author', 'Split'),
        ('m-quiet', 'p-voted', 'author', 'Quiet');`);
    await connection.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ?',
      [
        Array.from({ length: 12 }, (_, index) => [
          `v-${index}`,
          `voter_${index}`,
          `voter${index}@example.test`,
          'x',
        ]),
      ],
    );
    // p-voted: 7 up, 2 down (score 5). m-split: 6 up, 4 down.
    await connection.query(
      'INSERT INTO votes (id, user_id, target_type, target_id, value) VALUES ?',
      [
        [
          ...Array.from({ length: 9 }, (_, index) => [
            `vp-${index}`,
            `v-${index}`,
            'post',
            'p-voted',
            index < 7 ? 1 : -1,
          ]),
          ...Array.from({ length: 10 }, (_, index) => [
            `vc-${index}`,
            `v-${index}`,
            'comment',
            'm-split',
            index < 6 ? 1 : -1,
          ]),
        ],
      ],
    );

    firstRun = await migrate();
    secondRun = await migrate();

    pool = createPool({ ...credentials, database, connectionLimit: 8 });
    const log = new CommunityModerationLogService(pool);
    const notifications = new NotificationsService(pool);
    posts = new PostsService(pool, notifications, accepting, log);
    comments = new CommentsService(pool, notifications, accepting);
    votes = new VotesService(pool, accepting);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  describe('migration 034', () => {
    it('applies once, and skips on a second run', () => {
      expect(firstRun.join('\n')).toContain(VERSION);
      expect(secondRun.join('\n')).not.toContain(VERSION);
    });

    it('leaves posts and comments exactly as a fresh installation has them', async () => {
      expect(await schema(database)).toEqual(await schema(fresh));
    });

    it('backfills the counters from the votes', async () => {
      expect(await stored('posts', 'p-voted')).toMatchObject({
        upvotes: 7,
        downvotes: 2,
        score: 5,
      });
      expect(await stored('posts', 'p-quiet')).toMatchObject({
        upvotes: 0,
        downvotes: 0,
        score: 0,
      });
      expect(await stored('comments', 'm-split')).toMatchObject({
        upvotes: 6,
        downvotes: 4,
        score: 2,
      });
    });

    // The backfill and the TypeScript mirror agree, so the definition the
    // tests and the README describe is the one the database stores.
    it('backfills the ranks the definition specifies', async () => {
      for (const id of ['p-voted', 'p-quiet']) {
        const row = await stored('posts', id);
        const created = new Date(row.created_at as Date);
        expect(Number(row.hot_rank)).toBeCloseTo(
          hotRank(Number(row.score), created),
          9,
        );
        expect(Number(row.rising_rank)).toBeCloseTo(
          risingRank(Number(row.score), created),
          9,
        );
      }
      expect(
        Number((await stored('comments', 'm-split')).controversy),
      ).toBeCloseTo(controversy(6, 4), 9);
      expect(Number((await stored('comments', 'm-quiet')).controversy)).toBe(0);
    });
  });

  describe('the vote path', () => {
    it('ranks a new post as score 0 at its creation time', async () => {
      const created = await posts.create(
        { title: 'New', content: 'Body', type: 'text', community_id: 'c-a' },
        'author',
      );
      const row = await stored('posts', created.id);
      expect(row).toMatchObject({ upvotes: 0, downvotes: 0, score: 0 });
      expect(Number(row.hot_rank)).toBeCloseTo(
        hotRank(0, new Date(row.created_at as Date)),
        9,
      );
    });

    it('recomputes on every vote, change and withdrawal', async () => {
      await votes.vote(
        { target_type: 'post', target_id: 'p-quiet', value: 1 },
        'reader',
      );
      expect(await stored('posts', 'p-quiet')).toMatchObject({
        upvotes: 1,
        score: 1,
      });
      await votes.vote(
        { target_type: 'post', target_id: 'p-quiet', value: -1 },
        'reader',
      );
      expect(await stored('posts', 'p-quiet')).toMatchObject({
        upvotes: 0,
        downvotes: 1,
        score: -1,
      });
      await votes.withdraw('post', 'p-quiet', 'reader');
      const row = await stored('posts', 'p-quiet');
      expect(row).toMatchObject({ upvotes: 0, downvotes: 0, score: 0 });
      expect(Number(row.hot_rank)).toBeCloseTo(
        hotRank(0, new Date(row.created_at as Date)),
        9,
      );

      await votes.vote(
        { target_type: 'comment', target_id: 'm-quiet', value: 1 },
        'reader',
      );
      await votes.vote(
        { target_type: 'comment', target_id: 'm-quiet', value: -1 },
        'pest',
      );
      expect(await stored('comments', 'm-quiet')).toMatchObject({
        upvotes: 1,
        downvotes: 1,
        score: 0,
        controversy: 2,
      });
    });

    // Each vote locks the target row first, so concurrent votes serialise
    // and the last recompute sees every vote.
    it('stays exact under concurrent votes on one post', async () => {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          votes.vote(
            {
              target_type: 'post',
              target_id: 'p-quiet',
              value: index % 3 === 0 ? -1 : 1,
            },
            `v-${index}`,
          ),
        ),
      );
      const [{ sum }] = await rows(
        "SELECT CAST(SUM(value) AS SIGNED) AS sum FROM votes WHERE target_type = 'post' AND target_id = 'p-quiet'",
      );
      expect(await stored('posts', 'p-quiet')).toMatchObject({
        upvotes: 8,
        downvotes: 4,
        score: Number(sum),
      });
    });
  });

  describe('listings', () => {
    beforeAll(async () => {
      // Many posts, so the plans choose their indexes for the real reason.
      await connection.query(
        `INSERT INTO posts (id, title, content, author_id, community_id, created_at, score, hot_rank, rising_rank) VALUES ?`,
        [
          Array.from({ length: 2000 }, (_, index) => {
            const created = new Date(
              Date.parse('2026-01-01T00:00:00Z') + index * 3600_000,
            );
            const score = (index * 37) % 101;
            return [
              `seed-${index}`,
              `Seed ${index}`,
              'Body',
              'author',
              index % 2 ? 'c-a' : 'c-b',
              created.toISOString().slice(0, 19).replace('T', ' '),
              score,
              hotRank(score, created),
              risingRank(score, created),
            ];
          }),
        ],
      );
      await connection.query(`
        INSERT INTO posts (id, title, content, author_id, community_id) VALUES
          ('p-pest', 'By pest', 'Body', 'pest', 'c-a'),
          ('p-hidden', 'Hidden', 'Body', 'author', 'c-hidden'),
          ('p-banned', 'Banned', 'Body', 'author', 'c-banned');
        UPDATE communities SET suspended_at = UTC_TIMESTAMP() WHERE id = 'c-hidden';
        INSERT INTO community_subscriptions (user_id, community_id) VALUES
          ('reader', 'c-a'), ('reader', 'c-hidden'), ('reader', 'c-banned');
        INSERT INTO community_bans (id, community_id, user_id, reason, created_by)
          VALUES ('ban-1', 'c-banned', 'reader', 'Spam', 'author');
        INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('reader', 'pest');
        ANALYZE TABLE posts, comments, community_subscriptions;`);
    }, 120_000);

    it.each(['hot', 'top', 'rising', 'new'] as const)(
      'GET /posts?sort=%s returns the stored order',
      async (sort) => {
        const page = await posts.findAll({ sort, limit: 50 });
        const key = {
          hot: 'hot_rank',
          top: 'score',
          rising: 'rising_rank',
          new: 'created_at',
        }[sort];
        const ordered = await rows(
          `SELECT id FROM posts WHERE removed_at IS NULL AND community_id NOT IN ('c-hidden')
           ${sort === 'rising' ? 'AND created_at >= CURRENT_TIMESTAMP - INTERVAL 24 HOUR' : ''}
           ORDER BY ${key} DESC, id DESC LIMIT 50`,
        );
        expect(page.items.map((item) => item.id)).toEqual(
          ordered.map((row) => String(row.id)),
        );
      },
    );

    it('limits sort=top to its window', async () => {
      const page = await posts.findAll({
        sort: 'top',
        time: 'week',
        limit: 100,
      });
      for (const item of page.items) {
        expect(Date.parse(item.created_at)).toBeGreaterThanOrEqual(
          Date.now() - 7 * 24 * 3600_000 - 60_000,
        );
      }
      expect(page.time).toBe('week');
    });

    it('feeds the reader only subscribed, visible, unbanned communities without blocked authors', async () => {
      const page = await posts.findFeed({ limit: 100 }, 'reader');
      const ids = page.items.map((item) => item.id);
      for (const excluded of ['p-pest', 'p-hidden', 'p-banned']) {
        expect(ids).not.toContain(excluded);
      }
      const communities = new Set(page.items.map((item) => item.community_id));
      expect([...communities]).toEqual(['c-a']);
      const [{ total }] = await rows(
        "SELECT COUNT(*) AS total FROM posts WHERE community_id = 'c-a' AND author_id <> 'pest' AND removed_at IS NULL",
      );
      expect(page.total).toBe(Number(total));
    });

    // The issue's index requirement, as plans.
    it('reads the global hot and top listings in index order, without a filesort', async () => {
      for (const [sort, index] of [
        ['hot', 'idx_posts_hot'],
        ['top', 'idx_posts_top'],
        ['new', 'idx_posts_created'],
      ] as const) {
        const row = postsRow(await explain({}, sort));
        expect(row).toMatchObject({ key: index });
        expect(String(row.Extra)).not.toContain('filesort');
      }
    });

    it('reads windows and community listings through an index, never a scan', async () => {
      for (const plan of [
        await explain({}, 'top', 'day'),
        await explain({}, 'rising'),
        await explain({ community_id: 'c-a' }, 'hot'),
        await explain({ community_id: 'c-a' }, 'top', 'week'),
        await explain({ subscriber_id: 'reader' }, 'hot'),
      ]) {
        const row = postsRow(plan);
        expect(row.type).not.toBe('ALL');
        expect(row.key).not.toBeNull();
      }
    });

    it('sorts a comment listing by the stored columns over its post index', async () => {
      for (const sort of ['top', 'controversial'] as const) {
        const plan = await rows(
          `EXPLAIN SELECT id FROM comments WHERE post_id = ? AND parent_id IS NULL AND removed_at IS NULL ${commentListOrder(sort)} LIMIT 20`,
          ['p-voted'],
        );
        expect(plan[0]).toMatchObject({ type: 'ref' });
      }
      const top = await comments.findTopLevel('p-voted', { sort: 'top' });
      expect(top.items.map((item) => item.id)).toEqual(['m-split', 'm-quiet']);
    });
  });
});
