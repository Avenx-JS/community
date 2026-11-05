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
  USER_COMMENTS_COUNT_SQL,
  USER_COMMUNITIES_COUNT_SQL,
  USER_COMMUNITIES_SQL,
  USER_POSTS_COUNT_SQL,
  UserActivityService,
  userCommentsSql,
  userPostsSql,
} from '../users/user-activity.service';
import { runSqlScript } from './sql-script';

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Runs the public author listings (GET /users/:username/posts, /comments,
// /communities) against a real MySQL server: the exclusion matrix, the
// community visibility rule in each branch, paging, and the plans of the two
// feeds on their composite indexes. Opt in with MYSQL_INTEGRATION_TEST=true
// and MYSQL_* credentials that may create and drop scratch databases;
// skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('user activity listings (MySQL)', () => {
  const database = `user_activity_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let service: UserActivityService;

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };
  const ids = (page: { items: { id: string }[] }) =>
    page.items.map((item) => item.id);

  beforeAll(async () => {
    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${snapshot}`,
    );

    // "author" is the person under test. Each community isolates one rule:
    //   c-live       visible content, plus removed content and a comment on
    //                a removed post, which must all stay hidden
    //   c-deleted    soft-deleted community with the author's content
    //   c-suspended  suspended community with the author's content
    //   c-created    created by the author, no content
    //   c-moderated  moderated by the author, no content
    //   c-subscribed only subscribed to: never listed
    //   c-removed    only a removed post and a comment on it: not listed
    // 3000 posts and 6000 comments by 50 other users make a scan the more
    // expensive plan, so the feed plans are meaningful.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('author', 'author', 'author@example.test', 'x'),
        ('owner', 'owner', 'owner@example.test', 'x'),
        ('quiet', 'quiet_user', 'quiet@example.test', 'x'),
        ('gone', 'deleted_0001', 'gone@example.test', 'x');
      UPDATE users SET deleted_at = UTC_TIMESTAMP() WHERE id = 'gone';
      INSERT INTO users (id, username, email, password_hash)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50)
        SELECT CONCAT('u', n), CONCAT('u', n), CONCAT('u', n, '@example.test'), 'x'
        FROM seq;
      INSERT INTO communities (id, creator_id, name, description) VALUES
        ('c-live', 'owner', 'live', 'Live community'),
        ('c-deleted', 'owner', 'deleted', NULL),
        ('c-suspended', 'owner', 'suspended', NULL),
        ('c-created', 'author', 'created', 'Made by author'),
        ('c-moderated', 'owner', 'moderated', NULL),
        ('c-subscribed', 'owner', 'subscribed', NULL),
        ('c-removed', 'owner', 'removed', NULL),
        ('c-bulk', 'owner', 'bulk', NULL);
      UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = 'owner'
        WHERE id = 'c-deleted';
      UPDATE communities SET suspended_at = UTC_TIMESTAMP() WHERE id = 'c-suspended';
      INSERT INTO community_subscriptions (user_id, community_id) VALUES
        ('author', 'c-live'), ('author', 'c-moderated'),
        ('author', 'c-subscribed'), ('quiet', 'c-live');
      INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES
        ('c-moderated', 'author', 'owner'), ('c-created', 'author', 'author');
      INSERT INTO posts (id, title, content, author_id, community_id, created_at) VALUES
        ('p-live-1', 'Live one', 'Body', 'author', 'c-live', '2026-03-01 10:00:00'),
        ('p-live-2', 'Live two', 'Body', 'author', 'c-live', '2026-03-01 10:00:00'),
        ('p-live-3', 'Live three', 'Body', 'author', 'c-live', '2026-03-02 10:00:00'),
        ('p-removed', 'Removed', 'Body', 'author', 'c-live', '2026-03-03 10:00:00'),
        ('p-deleted', 'In deleted', 'Body', 'author', 'c-deleted', '2026-03-04 10:00:00'),
        ('p-suspended', 'In suspended', 'Body', 'author', 'c-suspended', '2026-03-05 10:00:00'),
        ('p-other', 'By owner', 'Body', 'owner', 'c-live', '2026-03-01 09:00:00'),
        ('p-other-removed', 'Removed by owner', 'Body', 'owner', 'c-removed', '2026-03-01 09:00:00'),
        ('p-only-removed', 'Removed', 'Body', 'author', 'c-removed', '2026-03-01 09:00:00'),
        ('p-other-deleted', 'In deleted', 'Body', 'owner', 'c-deleted', '2026-03-01 09:00:00'),
        ('p-other-suspended', 'In suspended', 'Body', 'owner', 'c-suspended', '2026-03-01 09:00:00');
      UPDATE posts SET removed_at = UTC_TIMESTAMP()
        WHERE id IN ('p-removed', 'p-other-removed', 'p-only-removed');
      INSERT INTO comments (id, post_id, author_id, content, created_at) VALUES
        ('m-live-1', 'p-other', 'author', 'Visible', '2026-04-01 10:00:00'),
        ('m-live-2', 'p-other', 'author', 'Visible too', '2026-04-01 10:00:00'),
        ('m-removed', 'p-other', 'author', 'Removed', '2026-04-02 10:00:00'),
        ('m-on-removed-post', 'p-other-removed', 'author', 'Post gone', '2026-04-03 10:00:00'),
        ('m-deleted', 'p-other-deleted', 'author', 'Deleted community', '2026-04-04 10:00:00'),
        ('m-suspended', 'p-other-suspended', 'author', 'Suspended', '2026-04-05 10:00:00');
      UPDATE comments SET removed_at = UTC_TIMESTAMP() WHERE id = 'm-removed';
      UPDATE comments SET edited_at = '2026-04-06 10:00:00' WHERE id = 'm-live-2';
      INSERT INTO posts (id, title, content, author_id, community_id, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 3000)
        SELECT CONCAT('bulk-p', n), 'Bulk', 'Body', CONCAT('u', 1 + n % 50), 'c-bulk',
               TIMESTAMP('2026-01-01 00:00:00') + INTERVAL n MINUTE
        FROM seq;
      INSERT INTO comments (id, post_id, author_id, content, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 6000)
        SELECT CONCAT('bulk-m', n), CONCAT('bulk-p', 1 + n % 3000), CONCAT('u', 1 + n % 50),
               'Bulk', TIMESTAMP('2026-01-01 00:00:00') + INTERVAL n MINUTE
        FROM seq;
      ANALYZE TABLE posts, comments, communities, community_moderators;`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    service = new UserActivityService(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  describe('posts', () => {
    it('lists only visible posts, newest first with the id tiebreaker', async () => {
      const result = await service.listPosts('author', {});
      expect(ids(result)).toEqual(['p-live-3', 'p-live-2', 'p-live-1']);
      expect(result).toMatchObject({ page: 1, limit: 20, total: 3 });
      expect(result.items[0]).toEqual({
        id: 'p-live-3',
        title: 'Live three',
        content: 'Body',
        type: 'text',
        author_id: 'author',
        community_id: 'c-live',
        created_at: expect.any(String),
        pinned_at: null,
        pinned_by: null,
      });
    });

    it('reverses with sort=oldest and pages each post exactly once', async () => {
      const oldest = await service.listPosts('author', { sort: 'oldest' });
      expect(ids(oldest)).toEqual(['p-live-1', 'p-live-2', 'p-live-3']);

      const paged: string[] = [];
      for (const page of [1, 2, 3, 4]) {
        const result = await service.listPosts('author', { page, limit: 1 });
        expect(result.total).toBe(3);
        paged.push(...ids(result));
      }
      expect(paged).toEqual(['p-live-3', 'p-live-2', 'p-live-1']);
    });
  });

  describe('comments', () => {
    it('lists only visible comments, flat, with their post and community', async () => {
      const result = await service.listComments('author', {});
      expect(ids(result)).toEqual(['m-live-2', 'm-live-1']);
      expect(result.total).toBe(2);
      expect(result.items[0]).toEqual({
        id: 'm-live-2',
        post_id: 'p-other',
        content: 'Visible too',
        created_at: expect.any(String),
        edited_at: expect.any(String),
        post_title: 'By owner',
        community_name: 'live',
      });
      expect(result.items[1].edited_at).toBeNull();
      expect(result.items[0]).not.toHaveProperty('replies');
    });

    it('reverses with sort=oldest', async () => {
      const result = await service.listComments('author', { sort: 'oldest' });
      expect(ids(result)).toEqual(['m-live-1', 'm-live-2']);
    });
  });

  describe('communities', () => {
    it('lists exactly the communities the activity reveals, by name, with the role', async () => {
      const result = await service.listCommunities('author', {});
      expect(result).toEqual({
        items: [
          { name: 'created', description: 'Made by author', role: 'creator' },
          { name: 'live', description: 'Live community', role: 'contributor' },
          { name: 'moderated', description: null, role: 'moderator' },
        ],
        page: 1,
        limit: 20,
        total: 3,
      });
    });

    it('pages by name', async () => {
      const second = await service.listCommunities('author', {
        page: 2,
        limit: 2,
      });
      expect(second.items.map((item) => item.name)).toEqual(['moderated']);
      expect(second.total).toBe(3);
    });

    it('never lists a subscription alone', async () => {
      await expect(service.listCommunities('quiet_user', {})).resolves.toEqual({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
      });
    });
  });

  it('answers an account without activity with empty pages', async () => {
    for (const list of [
      service.listPosts('quiet_user', {}),
      service.listComments('quiet_user', {}),
    ]) {
      await expect(list).resolves.toEqual({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
      });
    }
  });

  it('answers 404 for an unknown user and for a deleted account', async () => {
    for (const username of ['nobody_here', 'deleted_0001']) {
      for (const list of [
        service.listPosts(username, {}),
        service.listComments(username, {}),
        service.listCommunities(username, {}),
      ]) {
        await expect(list).rejects.toMatchObject({ status: 404 });
      }
    }
  });

  describe('plans', () => {
    const explain = (sql: string, values: unknown[]) =>
      rows(`EXPLAIN ${sql}`, values);

    it.each(['new', 'oldest'] as const)(
      'reads the post feed (%s) on idx_posts_author_created without a filesort',
      async (sort) => {
        const plan = await explain(userPostsSql(sort), ['u7', 20, 20]);
        const posts = plan.filter((row) => row.table === 'posts');
        expect(posts).toHaveLength(1);
        expect(posts[0].key).toBe('idx_posts_author_created');
        expect(posts[0].type).toBe('ref');
        for (const row of plan) {
          expect(String(row.Extra)).not.toContain('Using filesort');
          expect(row.type).not.toBe('ALL');
        }
      },
    );

    it.each(['new', 'oldest'] as const)(
      'reads the comment feed (%s) on idx_comments_author_created without a filesort',
      async (sort) => {
        const plan = await explain(userCommentsSql(sort), ['u7', 20, 20]);
        expect(plan.map((row) => String(row.table))).toEqual(['c', 'p', 'co']);
        expect(plan[0].key).toBe('idx_comments_author_created');
        expect(plan[0].type).toBe('ref');
        expect(plan[1].key).toBe('PRIMARY');
        expect(plan[2].key).toBe('PRIMARY');
        for (const row of plan) {
          expect(String(row.Extra)).not.toContain('Using filesort');
        }
      },
    );

    it('counts both feeds on the same indexes', async () => {
      const posts = await explain(USER_POSTS_COUNT_SQL, ['u7']);
      expect(posts.find((row) => row.table === 'posts')?.key).toBe(
        'idx_posts_author_created',
      );
      const comments = await explain(USER_COMMENTS_COUNT_SQL, ['u7']);
      expect(comments[0]).toMatchObject({
        table: 'c',
        key: 'idx_comments_author_created',
      });
    });

    it('starts every branch of the community listing from an index led by the user', async () => {
      const plan = await explain(USER_COMMUNITIES_SQL, [
        'u7',
        'u7',
        'u7',
        'u7',
        'u7',
        'u7',
        20,
        0,
      ]);
      // The UNION's temporary result (<unionN,...>) is read in full by
      // nature; it holds only the person's own community ids. No base table
      // may be scanned.
      const scans = plan.filter(
        (row) => row.type === 'ALL' && !String(row.table).startsWith('<union'),
      );
      expect(scans.map((row) => String(row.table))).toEqual([]);
      await expect(
        explain(USER_COMMUNITIES_COUNT_SQL, ['u7', 'u7', 'u7', 'u7']),
      ).resolves.toBeDefined();
    });
  });
});
