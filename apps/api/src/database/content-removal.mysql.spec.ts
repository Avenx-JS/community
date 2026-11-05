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
import { CommentRemovalService } from '../comments/comment-removals.service';
import { CommentsService } from '../comments/comments.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { CommunityStatsService } from '../communities/community-stats.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { VotesService } from '../votes/votes.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Moderative removal against a real MySQL server: removal keeps the post,
// its comments and its votes, restoration brings them back unchanged; reads
// hide removed content from everyone but its reviewers (the community's
// creator and moderators, and platform admins); the thread keeps a removed
// comment as a tombstone; statistics exclude removed content; and the plans
// of the exclusion predicates. Opt in with MYSQL_INTEGRATION_TEST=true and
// MYSQL_* credentials that may create and drop scratch databases; skipped
// otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('content removal (MySQL)', () => {
  const database = `content_removal_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let posts: PostsService;
  let comments: CommentsService;
  let removals: CommentRemovalService;
  let votes: VotesService;
  let stats: CommunityStatsService;
  const accepting = {
    assertAcceptedOrThrow: () => Promise.resolve(),
  } as unknown as CommunityRuleAcceptanceService;

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
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
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash, role) VALUES
        ('creator', 'creator', 'creator@example.test', 'x', 'user'),
        ('mod', 'mod', 'mod@example.test', 'x', 'user'),
        ('gone-mod', 'gone_mod', 'gone@example.test', 'x', 'user'),
        ('author', 'author', 'author@example.test', 'x', 'user'),
        ('member', 'member', 'member@example.test', 'x', 'user'),
        ('admin', 'admin', 'admin@example.test', 'x', 'admin'),
        ('platform-mod', 'platform_mod', 'pmod@example.test', 'x', 'moderator');
      INSERT INTO communities (id, creator_id, name) VALUES ('c1', 'creator', 'one');
      INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES
        ('c1', 'mod', 'creator'), ('c1', 'gone-mod', 'creator');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p1', 'Thread', 'Body', 'author', 'c1'),
        ('p2', 'Other', 'Body', 'author', 'c1');
      INSERT INTO comments (id, post_id, author_id, parent_id, content) VALUES
        ('root', 'p1', 'author', NULL, 'Root'),
        ('reply', 'p1', 'member', 'root', 'Reply'),
        ('nested', 'p1', 'author', 'reply', 'Nested');
      INSERT INTO votes (id, user_id, target_type, target_id, value) VALUES
        ('v1', 'member', 'post', 'p1', 1),
        ('v2', 'mod', 'post', 'p1', 1),
        ('v3', 'author', 'comment', 'reply', -1);
      -- Bulk rows so the plans are not decided by a near-empty table.
      INSERT INTO posts (id, title, content, author_id, community_id, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
        SELECT CONCAT('bulk-', n), 'Bulk', 'Body', 'author', 'c1',
               TIMESTAMP('2026-01-01 00:00:00') + INTERVAL n MINUTE
        FROM seq;
      UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'mod'
        WHERE id IN ('bulk-10', 'bulk-20', 'bulk-30');
      ANALYZE TABLE posts, comments, votes, users, communities;`);

    pool = createPool({ ...credentials, database, connectionLimit: 3 });
    const notifications = new NotificationsService(pool);
    const moderationLog = new CommunityModerationLogService(pool);
    posts = new PostsService(pool, notifications, accepting, moderationLog);
    comments = new CommentsService(pool, notifications, accepting);
    removals = new CommentRemovalService(
      pool,
      comments,
      notifications,
      moderationLog,
    );
    votes = new VotesService(pool, accepting);
    stats = new CommunityStatsService(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  const counts = async () => ({
    comments: (await rows("SELECT id FROM comments WHERE post_id = 'p1'"))
      .length,
    votes: (
      await rows("SELECT id FROM votes WHERE target_id IN ('p1', 'reply')")
    ).length,
  });

  it('keeps a removed post, its comments and votes, and restores them intact', async () => {
    const before = await counts();
    const [{ now }] = await rows('SELECT UTC_TIMESTAMP() AS now');

    const removed = await posts.removeContent('p1', { reason: 'Spam' }, 'mod');
    expect(removed).toMatchObject({
      removed: true,
      removed_by: 'mod',
      removal_reason: 'Spam',
      score: 2,
    });
    expect(
      Math.abs(
        new Date(removed.removed_at!).getTime() -
          new Date(now as Date).getTime(),
      ),
    ).toBeLessThan(60_000);
    expect(await rows("SELECT id FROM posts WHERE id = 'p1'")).toHaveLength(1);
    expect(await counts()).toEqual(before);

    const [notice] = await rows(
      "SELECT actor_id, metadata FROM notifications WHERE subject_id = 'p1' AND type = 'content_removed'",
    );
    expect(notice.actor_id).toBeNull();
    expect(JSON.stringify(notice.metadata)).not.toMatch(/Spam|mod/);

    await posts.restore('p1', 'creator');
    const [row] = await rows(
      "SELECT removed_at, removed_by, removal_reason FROM posts WHERE id = 'p1'",
    );
    expect(row).toEqual({
      removed_at: null,
      removed_by: null,
      removal_reason: null,
    });
    expect(await counts()).toEqual(before);
    const actions = await rows(
      "SELECT action FROM community_moderation_actions WHERE target_id = 'p1' ORDER BY created_at, id",
    );
    expect(actions.map((entry) => String(entry.action))).toEqual([
      'post_removed',
      'post_restored',
    ]);
  });

  describe('who may read removed content', () => {
    beforeAll(async () => {
      await posts.removeContent('p2', { reason: 'Off-topic' }, 'gone-mod');
      await removals.remove('reply', { reason: 'Rude' }, 'mod');
      // The moderator who removed p2 deletes their account.
      await connection.query("DELETE FROM users WHERE id = 'gone-mod'");
    });

    it.each([undefined, 'author', 'member', 'platform-mod'])(
      'answers %s with 404 for a removed post',
      async (viewer) => {
        await expect(posts.findOne('p2', viewer)).rejects.toMatchObject({
          status: 404,
        });
      },
    );

    it.each(['mod', 'creator', 'admin'])(
      'shows %s the removed post with removed_by null for a deleted moderator',
      async (viewer) => {
        await expect(posts.findOne('p2', viewer)).resolves.toMatchObject({
          id: 'p2',
          content: 'Body',
          removed: true,
          removed_by: null,
          removal_reason: 'Off-topic',
        });
      },
    );

    it.each([undefined, 'author', 'member'])(
      'shows %s a tombstone for the removed comment, with its replies',
      async (viewer) => {
        const thread = await comments.findThread('p1', viewer);
        const node = thread.comments[0].replies[0];
        expect(node).toEqual({
          id: 'reply',
          post_id: 'p1',
          parent_id: 'root',
          created_at: expect.any(String) as unknown,
          removed: true,
          replies: [expect.objectContaining({ id: 'nested' })],
        });
      },
    );

    it.each(['mod', 'creator', 'admin'])(
      'shows %s the removed comment in full',
      async (viewer) => {
        const thread = await comments.findThread('p1', viewer);
        expect(thread.comments[0].replies[0]).toMatchObject({
          id: 'reply',
          content: 'Reply',
          removed: true,
          removed_by: 'mod',
          removal_reason: 'Rude',
        });
      },
    );

    it('excludes removed content from listings and statistics', async () => {
      const page = await posts.findAll({ community_id: 'c1', limit: 100 });
      expect(page.items.map((post) => post.id)).not.toContain('p2');
      const result = await stats.get('one');
      // 2002 posts, minus p2 and the three removed bulk posts; 3 comments
      // minus the removed reply.
      expect(result.post_count).toBe(1998);
      expect(result.comment_count).toBe(2);
    });

    it('refuses votes and comments on removed content with 409', async () => {
      await expect(
        votes.vote(
          { target_type: 'post', target_id: 'p2', value: 1 },
          'member',
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        votes.vote(
          { target_type: 'comment', target_id: 'reply', value: 1 },
          'member',
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        comments.create('p2', { content: 'Hi' }, 'member'),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        comments.create('p1', { content: 'Hi', parent_id: 'reply' }, 'member'),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('refuses to restore a comment while its post is removed', async () => {
      await connection.query(
        "UPDATE comments SET removed_at = UTC_TIMESTAMP(), removed_by = 'mod' WHERE id = 'root'",
      );
      await posts.removeContent('p1', {}, 'mod');
      await expect(removals.restore('root', 'mod')).rejects.toMatchObject({
        status: 409,
      });
      await posts.restore('p1', 'mod');
      await expect(removals.restore('root', 'mod')).resolves.toBeDefined();
    });
  });

  // Measured on MySQL 8.0. The exclusion predicates in listings are
  // filters on the listing's own (filter, created_at, id) index, never a
  // scan; idx_posts_removed_at serves the opposite question, finding the
  // few removed posts, which is how a reviewer queue would ask.
  describe('plans', () => {
    it('filters removed posts within the community listing index', async () => {
      const plan = await rows(
        "EXPLAIN SELECT id FROM posts WHERE community_id = 'c1' AND posts.removed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 20",
      );
      expect(plan[0]).toMatchObject({ key: 'idx_posts_community_created' });
      expect(plan[0].type).not.toBe('ALL');
    });

    it('finds removed posts through idx_posts_removed_at', async () => {
      const plan = await rows(
        'EXPLAIN SELECT id FROM posts WHERE removed_at IS NOT NULL',
      );
      expect(plan[0]).toMatchObject({ key: 'idx_posts_removed_at' });
      expect(plan[0].type).toBe('range');
    });

    it('finds removed comments through idx_comments_removed_at', async () => {
      await connection.query(`
        INSERT INTO comments (id, post_id, author_id, content)
          WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
          SELECT CONCAT('bulk-c-', n), 'p1', 'member', 'Bulk' FROM seq;
        ANALYZE TABLE comments;`);
      const plan = await rows(
        'EXPLAIN SELECT id FROM comments WHERE removed_at IS NOT NULL',
      );
      expect(plan[0]).toMatchObject({ key: 'idx_comments_removed_at' });
    });
  });
});
