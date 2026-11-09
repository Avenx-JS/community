import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
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
import { CommentsService } from '../comments/comments.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { ListNotificationsDto } from '../notifications/dto/list-notifications.dto';
import {
  buildNotificationListQuery,
  NotificationInboxService,
  UNREAD_COUNT_SQL,
} from '../notifications/notification-inbox.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { VotesService } from '../votes/votes.service';
import {
  BLOCKED_BETWEEN_SQL,
  UserBlockPolicyService,
} from '../users/user-block-policy.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Block enforcement against a real MySQL server: the plan of the block lookup
// and of the inbox filter, the gated writes in both directions, and the
// moderation immunity. Seeded with many blocks and notifications so an index
// is the cheap path. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_*
// credentials that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('user block enforcement (MySQL)', () => {
  const database = `user_block_enforcement_${randomBytes(4).toString('hex')}`;
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
  let blocks: UserBlockPolicyService;
  let comments: CommentsService;
  let votes: VotesService;
  let posts: PostsService;
  let inbox: NotificationInboxService;

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const block = (blocker: string, blocked: string) =>
    connection.query(
      'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)',
      [blocker, blocked],
    );
  const unblockAll = () =>
    connection.query(
      'DELETE FROM user_blocks WHERE blocker_id IN (?, ?, ?, ?)',
      ['alice', 'bob', 'moderator', 'carol'],
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
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('alice', 'alice', 'alice@example.test', 'x'),
        ('bob', 'bob', 'bob@example.test', 'x'),
        ('carol', 'carol', 'carol@example.test', 'x'),
        ('moderator', 'moderator', 'moderator@example.test', 'x'),
        ('creator', 'creator', 'creator@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES ('c-1', 'creator', 'garden');
      INSERT INTO community_moderators (community_id, user_id, assigned_by)
        VALUES ('c-1', 'moderator', 'creator');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-alice', 'By Alice', 'Body', 'alice', 'c-1'),
        ('p-bob', 'By Bob', 'Body', 'bob', 'c-1');
      INSERT INTO comments (id, post_id, author_id, content) VALUES
        ('m-alice', 'p-bob', 'alice', 'Alice on Bob'),
        ('m-carol', 'p-alice', 'carol', 'Carol on Alice');`);
    // Many accounts with blocks, and many notifications for alice, so the
    // optimiser has a reason to use the indexes.
    const filler = Array.from({ length: 800 }, (_, index) => [
      `u-${index}`,
      `user_${index}`,
      `user${index}@example.test`,
      'x',
    ]);
    await connection.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ?',
      [filler],
    );
    await connection.query(
      'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ?',
      [
        Array.from({ length: 800 }, (_, index) => [
          `u-${index}`,
          `u-${(index + 1) % 800}`,
        ]),
      ],
    );
    await connection.query(
      `INSERT INTO notifications
         (id, recipient_id, type, actor_id, subject_type, subject_id, community_id)
       VALUES ?`,
      [
        Array.from({ length: 1000 }, (_, index) => [
          `n-${index}`,
          index % 4 === 0 ? 'alice' : `u-${index % 800}`,
          'post_comment',
          index % 10 === 0 ? null : `u-${(index * 7) % 800}`,
          'comment',
          `m-${index}`,
          'c-1',
        ]),
      ],
    );
    await connection.query('ANALYZE TABLE user_blocks, notifications, users');

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    blocks = new UserBlockPolicyService(pool);
    const notifications = new NotificationsService(pool);
    comments = new CommentsService(pool, notifications, accepting, blocks);
    votes = new VotesService(pool, accepting, blocks);
    posts = new PostsService(
      pool,
      notifications,
      accepting,
      new CommunityModerationLogService(pool),
    );
    inbox = new NotificationInboxService(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('reads each direction of the block lookup through an index', async () => {
    const plan = await rows(`EXPLAIN ${BLOCKED_BETWEEN_SQL}`, [
      'u-1',
      'u-2',
      'u-2',
      'u-1',
    ]);
    const keys = plan
      .filter((row) => row.table === 'user_blocks')
      .map((row) => String(row.key));
    expect(keys.sort()).toEqual(['PRIMARY', 'idx_user_blocks_blocked'].sort());
    for (const row of plan) {
      expect(row.type).not.toBe('ALL');
    }
  });

  it('filters the inbox through its index, never a scan', async () => {
    const { sql, values } = buildNotificationListQuery(
      'alice',
      Object.assign(new ListNotificationsDto(), {}),
    );
    for (const [statement, bound] of [
      [sql, values],
      [UNREAD_COUNT_SQL, ['alice', 'alice', 'alice']],
    ] as const) {
      const plan = await rows(`EXPLAIN ${statement}`, [...bound]);
      expect(plan.find((row) => row.table === 'notifications')?.key).toMatch(
        /^idx_notifications_recipient/,
      );
      for (const row of plan) {
        expect([row.table, row.type]).not.toEqual([row.table, 'ALL']);
      }
    }
  });

  it('refuses comments and votes in both directions with one payload', async () => {
    await block('alice', 'bob');
    const refusals: string[] = [];
    for (const attempt of [
      () => comments.create('p-alice', { content: 'Hi' }, 'bob'),
      () => comments.create('p-bob', { content: 'Hi' }, 'alice'),
      () =>
        votes.vote(
          { target_type: 'post', target_id: 'p-alice', value: 1 },
          'bob',
        ),
      () =>
        votes.vote(
          { target_type: 'comment', target_id: 'm-alice', value: 1 },
          'bob',
        ),
      () =>
        votes.vote(
          { target_type: 'post', target_id: 'p-bob', value: 1 },
          'alice',
        ),
    ]) {
      const error = await attempt().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ForbiddenException);
      refusals.push(
        JSON.stringify((error as ForbiddenException).getResponse()),
      );
    }
    expect(new Set(refusals)).toEqual(new Set(['{"reason":"user_blocked"}']));
    expect(
      Number(
        (
          await rows(
            "SELECT COUNT(*) AS total FROM votes WHERE user_id IN ('alice', 'bob')",
          )
        )[0].total,
      ),
    ).toBe(0);
    // A reply to carol's comment under alice's post is directed at carol.
    await expect(
      comments.create(
        'p-alice',
        { content: 'To Carol', parent_id: 'm-carol' },
        'bob',
      ),
    ).resolves.toMatchObject({ parent_id: 'm-carol' });
    await unblockAll();
  });

  it('never stops a moderator acting on a user who blocked them', async () => {
    await block('alice', 'moderator');
    await block('moderator', 'alice');
    await posts.removeContent('p-alice', { reason: 'Off-topic' }, 'moderator');
    expect(
      (await rows("SELECT removed_at FROM posts WHERE id = 'p-alice'"))[0]
        .removed_at,
    ).not.toBeNull();
    await unblockAll();
  });

  it('hides a blocked actor in the inbox on read, and an unblock restores it', async () => {
    await connection.query(
      `INSERT INTO notifications (id, recipient_id, type, actor_id, subject_type, subject_id, community_id)
       VALUES ('from-bob', 'alice', 'post_comment', 'bob', 'comment', 'm-x', 'c-1'),
              ('from-moderation', 'alice', 'content_removed', NULL, 'post', 'p-alice', 'c-1')`,
    );
    const ids = async () =>
      (
        await inbox.list(
          'alice',
          Object.assign(new ListNotificationsDto(), { limit: 100 }),
        )
      ).items.map((item) => item.id);
    expect(await ids()).toContain('from-bob');
    const unreadBefore = (await inbox.unreadCount('alice')).unread;

    await block('bob', 'alice');
    expect(await ids()).not.toContain('from-bob');
    expect(await ids()).toContain('from-moderation');
    expect((await inbox.unreadCount('alice')).unread).toBe(unreadBefore - 1);
    expect(
      (await rows("SELECT id FROM notifications WHERE id = 'from-bob'")).length,
    ).toBe(1);

    await unblockAll();
    expect(await ids()).toContain('from-bob');
  });
});
