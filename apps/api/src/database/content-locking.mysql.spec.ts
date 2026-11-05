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
import { CommentLocksService } from '../comments/comment-locks.service';
import {
  CommentsService,
  MAX_LOCK_ANCESTOR_DEPTH,
  PARENT_WITH_ANCESTRY_SQL,
} from '../comments/comments.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { VotesService } from '../votes/votes.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Post and comment locks against a real MySQL server: the recursive ancestor
// check (PARENT_WITH_ANCESTRY_SQL) at every depth, its bound and its plan,
// the moderator-only lock routes with their log entries, and what a lock
// leaves alone (voting, the author's edits and deletions). Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and
// drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('content locking (MySQL)', () => {
  const database = `content_locking_${randomBytes(4).toString('hex')}`;
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
  let locks: CommentLocksService;
  let votes: VotesService;
  const accepting = {
    assertAcceptedOrThrow: () => Promise.resolve(),
  } as unknown as CommunityRuleAcceptanceService;

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };
  const reply = (parentId: string, actor = 'member') =>
    comments.create('p1', { content: 'A reply', parent_id: parentId }, actor);
  const setCommentLock = (id: string, locked: boolean) =>
    connection.query(
      locked
        ? "UPDATE comments SET locked_at = UTC_TIMESTAMP(), locked_by = 'mod' WHERE id = ?"
        : 'UPDATE comments SET locked_at = NULL, locked_by = NULL WHERE id = ?',
      [id],
    );

  beforeAll(async () => {
    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${snapshot}`,
    );
    // p1: root → d2 → d3 → d4 → d5, and a sibling subtree root → s2.
    // p-deep: a chain of MAX_LOCK_ANCESTOR_DEPTH + 20 comments.
    const chain = MAX_LOCK_ANCESTOR_DEPTH + 20;
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('creator', 'creator', 'creator@example.test', 'x'),
        ('mod', 'mod', 'mod@example.test', 'x'),
        ('other-mod', 'other_mod', 'other@example.test', 'x'),
        ('author', 'author', 'author@example.test', 'x'),
        ('member', 'member', 'member@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c1', 'creator', 'one'), ('c2', 'creator', 'two');
      INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES
        ('c1', 'mod', 'creator'), ('c2', 'other-mod', 'creator');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p1', 'Thread', 'Body', 'author', 'c1'),
        ('p-deep', 'Deep', 'Body', 'author', 'c1');
      INSERT INTO comments (id, post_id, author_id, parent_id, content) VALUES
        ('root', 'p1', 'author', NULL, 'Root'),
        ('d2', 'p1', 'member', 'root', 'Depth 2'),
        ('d3', 'p1', 'author', 'd2', 'Depth 3'),
        ('d4', 'p1', 'member', 'd3', 'Depth 4'),
        ('d5', 'p1', 'author', 'd4', 'Depth 5'),
        ('s2', 'p1', 'member', 'root', 'Sibling');
      SET SESSION foreign_key_checks = 0;
      INSERT INTO comments (id, post_id, author_id, parent_id, content)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${chain})
        SELECT CONCAT('chain-', n), 'p-deep', 'member',
               IF(n = 1, NULL, CONCAT('chain-', n - 1)), 'Link'
        FROM seq;
      SET SESSION foreign_key_checks = 1;
      ANALYZE TABLE comments, posts;`);

    pool = createPool({ ...credentials, database, connectionLimit: 3 });
    const notifications = new NotificationsService(pool);
    const moderationLog = new CommunityModerationLogService(pool);
    posts = new PostsService(pool, notifications, accepting, moderationLog);
    comments = new CommentsService(pool, notifications, accepting);
    locks = new CommentLocksService(pool, comments, moderationLog);
    votes = new VotesService(pool, accepting);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  describe('the ancestor check', () => {
    it.each([
      ['the direct parent', 'd5', 'd5'],
      ['the grandparent', 'd4', 'd5'],
      ['the great-grandparent', 'd3', 'd5'],
      ['the root, below which the reply would sit at depth 6', 'root', 'd5'],
      ['the root, for a reply at depth 4', 'root', 'd3'],
    ])(
      'refuses a reply when %s is locked',
      async (_label, lockedId, parentId) => {
        await setCommentLock(lockedId, true);
        try {
          await expect(reply(parentId)).rejects.toMatchObject({
            status: 409,
            message:
              'A comment above this reply is locked; its thread accepts no new replies',
          });
        } finally {
          await setCommentLock(lockedId, false);
        }
      },
    );

    it('keeps a sibling subtree open', async () => {
      await setCommentLock('d2', true);
      try {
        await expect(reply('s2')).resolves.toMatchObject({ parent_id: 's2' });
        await expect(reply('root')).resolves.toMatchObject({
          parent_id: 'root',
        });
        await expect(reply('d3')).rejects.toMatchObject({ status: 409 });
      } finally {
        await setCommentLock('d2', false);
      }
    });

    it('binds moderators and the creator too', async () => {
      await setCommentLock('root', true);
      try {
        for (const actor of ['mod', 'creator']) {
          await expect(reply('d2', actor)).rejects.toMatchObject({
            status: 409,
          });
        }
      } finally {
        await setCommentLock('root', false);
      }
    });

    it('answers an unknown parent with 404, even under a locked post', async () => {
      await connection.query(
        "UPDATE posts SET locked_at = UTC_TIMESTAMP(), locked_by = 'mod' WHERE id = 'p1'",
      );
      try {
        await expect(reply('no-such-comment')).rejects.toMatchObject({
          status: 404,
        });
        await expect(reply('chain-1')).rejects.toMatchObject({ status: 404 });
        await expect(
          comments.create('p1', { content: 'Top' }, 'member'),
        ).rejects.toMatchObject({
          status: 409,
          message: 'This post is locked; it accepts no new comments',
        });
      } finally {
        await connection.query(
          "UPDATE posts SET locked_at = NULL, locked_by = NULL WHERE id = 'p1'",
        );
      }
    });

    it('walks exactly up to the bound and fails closed beyond it', async () => {
      // A parent at depth MAX_LOCK_ANCESTOR_DEPTH: the walk reaches the root
      // within the bound, so the reply is allowed.
      await expect(
        comments.create(
          'p-deep',
          {
            content: 'At the bound',
            parent_id: `chain-${MAX_LOCK_ANCESTOR_DEPTH}`,
          },
          'member',
        ),
      ).resolves.toBeDefined();
      // One deeper, ancestors remain unchecked: refused rather than let through.
      await expect(
        comments.create(
          'p-deep',
          {
            content: 'Past the bound',
            parent_id: `chain-${MAX_LOCK_ANCESTOR_DEPTH + 1}`,
          },
          'member',
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('stays below the default cte_max_recursion_depth, so the bound ends the walk, not a server error', async () => {
      await connection.query('SET SESSION cte_max_recursion_depth = 1000');
      const [row] = await rows(PARENT_WITH_ANCESTRY_SQL, [
        `chain-${MAX_LOCK_ANCESTOR_DEPTH + 20}`,
        'p-deep',
        MAX_LOCK_ANCESTOR_DEPTH,
        MAX_LOCK_ANCESTOR_DEPTH,
      ]);
      expect(Number(row.depth_exceeded)).toBe(1);
      expect(Number(row.thread_locked)).toBe(0);
    });

    // Measured on MySQL 8.0: the anchor is a const read of the parent by
    // primary key, each recursive step an eq_ref on the primary key: one
    // index lookup per level, never a scan of comments.
    it('plans the walk as primary-key lookups, one per level', async () => {
      const plan = await rows(`EXPLAIN ${PARENT_WITH_ANCESTRY_SQL}`, [
        'd5',
        'p1',
        MAX_LOCK_ANCESTOR_DEPTH,
        MAX_LOCK_ANCESTOR_DEPTH,
      ]);
      const commentRows = plan.filter((row) => row.table === 'comments');
      expect(commentRows.length).toBeGreaterThanOrEqual(2);
      for (const row of commentRows) {
        expect(row.key).toBe('PRIMARY');
        expect(['const', 'eq_ref']).toContain(row.type);
      }
      expect(plan.some((row) => String(row.Extra).includes('Recursive'))).toBe(
        true,
      );
    });
  });

  describe('the lock routes', () => {
    const logActions = async (targetId: string) =>
      (
        await rows(
          'SELECT action FROM community_moderation_actions WHERE target_id = ? ORDER BY created_at, id',
          [targetId],
        )
      ).map((row) => String(row.action));

    it('locks and unlocks a post, logging each change once, from the database clock', async () => {
      const [{ now }] = await rows('SELECT UTC_TIMESTAMP() AS now');
      const locked = await posts.lock('p1', 'mod');
      expect(locked).toMatchObject({ locked_by: 'mod' });
      expect(
        Math.abs(
          new Date(locked.locked_at!).getTime() -
            new Date(now as Date).getTime(),
        ),
      ).toBeLessThan(60_000);

      const again = await posts.lock('p1', 'creator');
      expect(again.locked_at).toBe(locked.locked_at);

      await expect(
        comments.create('p1', { content: 'Top' }, 'member'),
      ).rejects.toMatchObject({ status: 409 });

      await posts.unlock('p1', 'creator');
      await posts.unlock('p1', 'creator');
      await expect(
        comments.create('p1', { content: 'Top' }, 'member'),
      ).resolves.toBeDefined();
      expect(await logActions('p1')).toEqual(['post_locked', 'post_unlocked']);
    });

    it('locks and unlocks a comment, and the subtree follows', async () => {
      await locks.lock('d3', 'mod');
      await expect(reply('d5')).rejects.toMatchObject({ status: 409 });
      await locks.unlock('d3', 'mod');
      await expect(reply('d5')).resolves.toBeDefined();
      expect(await logActions('d3')).toEqual([
        'comment_locked',
        'comment_unlocked',
      ]);
    });

    it.each(['author', 'member', 'other-mod'])(
      'refuses %s with 403 on posts and comments',
      async (actor) => {
        await expect(posts.lock('p1', actor)).rejects.toMatchObject({
          status: 403,
        });
        await expect(locks.lock('root', actor)).rejects.toMatchObject({
          status: 403,
        });
      },
    );

    it('renders a lock whose moderator account is gone with locked_by null', async () => {
      await connection.query(
        "UPDATE comments SET locked_at = UTC_TIMESTAMP(), locked_by = NULL WHERE id = 's2'",
      );
      await expect(locks.lock('s2', 'mod')).resolves.toMatchObject({
        locked_by: null,
      });
      await setCommentLock('s2', false);
    });
  });

  describe('what a lock leaves alone', () => {
    it('lets anyone vote on locked content', async () => {
      await posts.lock('p1', 'mod');
      await locks.lock('d4', 'mod');
      try {
        await expect(
          votes.vote(
            { target_type: 'post', target_id: 'p1', value: 1 },
            'member',
          ),
        ).resolves.toMatchObject({ value: 1 });
        await expect(
          votes.vote(
            { target_type: 'comment', target_id: 'd4', value: -1 },
            'author',
          ),
        ).resolves.toMatchObject({ value: -1 });
      } finally {
        await locks.unlock('d4', 'mod');
        await posts.unlock('p1', 'mod');
      }
    });

    it('lets authors edit and delete their own locked content', async () => {
      await posts.lock('p1', 'mod');
      await locks.lock('d5', 'mod');
      await expect(
        posts.update('p1', { title: 'Corrected' }, 'author'),
      ).resolves.toMatchObject({ title: 'Corrected' });
      await expect(
        comments.update('d5', { content: 'Corrected' }, 'author'),
      ).resolves.toMatchObject({ content: 'Corrected' });
      await expect(comments.remove('d5', 'author')).resolves.toBeUndefined();
      expect(await rows("SELECT id FROM comments WHERE id = 'd5'")).toEqual([]);
      await posts.unlock('p1', 'mod');
    });
  });
});
