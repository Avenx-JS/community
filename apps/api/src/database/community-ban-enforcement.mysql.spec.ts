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
import { ACTIVE_COMMUNITY_BAN_STATE_SQL } from '../common/active-community-ban';
import { CommunitiesService } from '../communities/communities.service';
import { CommunityBansService } from '../communities/community-bans.service';
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

// Community-ban enforcement against a real MySQL server: the plan of the ban
// lookup every gated write runs, the four gated paths, expiry by predicate
// alone, the lift, and the isolation from other communities and from platform
// restrictions. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_*
// credentials that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community ban enforcement (MySQL)', () => {
  const database = `community_ban_enforcement_${randomBytes(4).toString('hex')}`;
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
  let communities: CommunitiesService;
  let posts: PostsService;
  let comments: CommentsService;
  let votes: VotesService;
  let bans: CommunityBansService;

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const refusal = async (attempt: () => Promise<unknown>) => {
    const error = await attempt().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenException);
    return (error as ForbiddenException).getResponse();
  };
  // The four gated paths, for member in community A.
  const participate = {
    subscribe: () => communities.subscribe('garden', 'member'),
    post: () =>
      posts.create(
        {
          title: 'Hi',
          content: 'Body',
          type: 'text',
          community_id: 'c-a',
        } as never,
        'member',
      ),
    comment: () => comments.create('p-a', { content: 'Hi' }, 'member'),
    vote: () =>
      votes.vote(
        { target_type: 'comment', target_id: 'm-a', value: 1 },
        'member',
      ),
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
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('creator', 'creator', 'creator@example.test', 'x'),
        ('moderator', 'moderator', 'moderator@example.test', 'x'),
        ('member', 'member', 'member@example.test', 'x'),
        ('author', 'author', 'author@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c-a', 'creator', 'garden'),
        ('c-b', 'creator', 'kitchen');
      INSERT INTO community_moderators (community_id, user_id, assigned_by)
        VALUES ('c-a', 'moderator', 'creator');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-a', 'In garden', 'Body', 'author', 'c-a'),
        ('p-b', 'In kitchen', 'Body', 'author', 'c-b');
      INSERT INTO comments (id, post_id, author_id, content) VALUES
        ('m-a', 'p-a', 'author', 'A comment in garden');`);
    // Many bans elsewhere, so the index is the cheap path.
    await connection.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ?',
      [
        Array.from({ length: 500 }, (_, index) => [
          `u-${index}`,
          `user_${index}`,
          `user${index}@example.test`,
          'x',
        ]),
      ],
    );
    await connection.query(
      'INSERT INTO community_bans (id, community_id, user_id, reason, created_by) VALUES ?',
      [
        Array.from({ length: 500 }, (_, index) => [
          `seed-${index}`,
          index % 2 ? 'c-a' : 'c-b',
          `u-${index}`,
          'Seed',
          'moderator',
        ]),
      ],
    );
    await connection.query('ANALYZE TABLE community_bans');

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    const log = new CommunityModerationLogService(pool);
    const notifications = new NotificationsService(pool);
    communities = new CommunitiesService(pool, accepting, log);
    posts = new PostsService(pool, notifications, accepting, log);
    comments = new CommentsService(pool, notifications, accepting);
    votes = new VotesService(pool, accepting);
    bans = new CommunityBansService(pool, log);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('serves the ban lookup from idx_community_bans_active', async () => {
    const plan = await rows(`EXPLAIN ${ACTIVE_COMMUNITY_BAN_STATE_SQL}`, [
      'c-a',
      'u-1',
    ]);
    expect(plan.find((row) => row.table === 'community_bans')).toMatchObject({
      key: 'idx_community_bans_active',
    });
    for (const row of plan) {
      expect(row.type).not.toBe('ALL');
    }
  });

  it('refuses all four paths for a banned user, telling them only where and until when', async () => {
    await bans.ban(
      'garden',
      {
        username: 'member',
        reason: 'Harassed three members',
        duration_hours: 48,
      },
      'moderator',
    );
    for (const attempt of Object.values(participate)) {
      const payload = await refusal(attempt);
      expect(payload).toEqual({
        reason: 'community_banned',
        community: 'garden',
        expires_at: expect.any(String) as unknown,
      });
      expect(JSON.stringify(payload)).not.toMatch(
        /Harassed|moderator|seed|"id"/,
      );
    }
    const written = await rows(
      `SELECT
         (SELECT COUNT(*) FROM community_subscriptions WHERE user_id = 'member') AS subscriptions,
         (SELECT COUNT(*) FROM posts WHERE author_id = 'member') AS posts,
         (SELECT COUNT(*) FROM comments WHERE author_id = 'member') AS comments,
         (SELECT COUNT(*) FROM votes WHERE user_id = 'member') AS votes,
         (SELECT COUNT(*) FROM user_restrictions) AS restrictions`,
    );
    expect(written[0]).toEqual({
      subscriptions: 0,
      posts: 0,
      comments: 0,
      votes: 0,
      restrictions: 0,
    });
  });

  it('leaves another community open', async () => {
    await communities.subscribe('kitchen', 'member');
    await comments.create('p-b', { content: 'Elsewhere' }, 'member');
  });

  // No job: the predicate compares expires_at with UTC_TIMESTAMP().
  it('stops applying the moment a temporary ban expires', async () => {
    await connection.query(
      "UPDATE community_bans SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE user_id = 'member'",
    );
    await participate.comment();
  });

  it('applies again to a new ban, and not after its lift', async () => {
    await bans.ban(
      'garden',
      { username: 'member', reason: 'Again' },
      'moderator',
    );
    expect(await refusal(participate.subscribe)).toEqual({
      reason: 'community_banned',
      community: 'garden',
    });
    await bans.lift('garden', 'member', {}, 'moderator');
    for (const attempt of Object.values(participate)) {
      await attempt();
    }
  });
});
