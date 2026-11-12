import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
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
import { AdminCommunitiesService } from '../admin/admin-communities.service';
import { AuditLogService } from '../admin/audit-log.service';
import { CommentsService, THREAD_POST_SQL } from '../comments/comments.service';
import {
  CommunitiesService,
  LISTED_COMMUNITY_ID_SQL,
} from '../communities/communities.service';
import { CommunityBansService } from '../communities/community-bans.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { CommunityRulesService } from '../communities/community-rules.service';
import { CommunityStatsService } from '../communities/community-stats.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { SearchService } from '../search/search.service';
import { UserActivityService } from '../users/user-activity.service';
import { VotesService } from '../votes/votes.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Community-suspension enforcement against a real MySQL server: every role
// loses the suspended community on the public routes, administrators keep it
// under /admin, search and activity omit its content, concurrent suspensions
// decide once, and restoration brings everything back as it was. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and
// drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community suspension enforcement (MySQL)', () => {
  const database = `community_suspension_enf_${randomBytes(4).toString('hex')}`;
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
  let admin: AdminCommunitiesService;
  let communities: CommunitiesService;
  let rules: CommunityRulesService;
  let stats: CommunityStatsService;
  let posts: PostsService;
  let comments: CommentsService;
  let votes: VotesService;
  let bans: CommunityBansService;
  let search: SearchService;
  let activity: UserActivityService;

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];

  // Every public read and write, as each caller would make it. The public
  // caller has no id; the others are a subscribed member, the community's
  // moderator, its creator and a platform administrator.
  const callsFor = (actor: string) => [
    () => communities.findOne('garden'),
    () => communities.getSubscription('garden', actor),
    () => communities.subscribe('garden', actor),
    () => communities.unsubscribe('garden', actor),
    () => communities.update('garden', { description: 'New' }, actor),
    () => communities.removeModerator('garden', 'member', actor),
    () => rules.getCurrent('garden'),
    () => stats.get('garden'),
    () => bans.ban('garden', { username: 'author', reason: 'x' }, actor),
    () =>
      posts.create(
        {
          title: 'Hi',
          content: 'Body',
          type: 'text',
          community_id: 'c-a',
        } as never,
        actor,
      ),
    () => posts.findOne('p-a', actor),
    () => posts.pin('p-a', actor),
    () => posts.removeContent('p-a', { reason: 'Spam' }, actor),
    () => comments.findThread('p-a'),
    () => comments.create('p-a', { content: 'Hi' }, actor),
    () =>
      votes.vote({ target_type: 'post', target_id: 'p-a', value: 1 }, actor),
  ];
  const publicCalls = [
    () => communities.findOne('garden'),
    () => rules.getCurrent('garden'),
    () => stats.get('garden'),
    () => posts.findOne('p-a'),
    () => comments.findThread('p-a'),
  ];
  const hiddenFrom = async (calls: Array<() => Promise<unknown>>) => {
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
  };
  const searchNames = async (type: 'communities' | 'posts', q: string) =>
    (
      (await search.search({ q, type, page: 1, limit: 20 } as never)) as {
        items: Array<{ name?: string; id?: string }>;
      }
    ).items.map((item) => item.name ?? item.id);

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
      INSERT INTO users (id, username, email, password_hash, role) VALUES
        ('creator', 'creator', 'creator@example.test', 'x', 'user'),
        ('moderator', 'moderator', 'moderator@example.test', 'x', 'user'),
        ('member', 'member', 'member@example.test', 'x', 'user'),
        ('author', 'author', 'author@example.test', 'x', 'user'),
        ('admin', 'admin', 'admin@example.test', 'x', 'admin');
      INSERT INTO communities (id, creator_id, name, description) VALUES
        ('c-a', 'creator', 'garden', 'Tomatoes and beans'),
        ('c-b', 'creator', 'kitchen', 'Tomatoes in the pan');
      INSERT INTO community_moderators (community_id, user_id, assigned_by)
        VALUES ('c-a', 'moderator', 'creator');
      INSERT INTO community_subscriptions (community_id, user_id) VALUES
        ('c-a', 'member'), ('c-a', 'author');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-a', 'Tomatoes in the garden', 'Body', 'author', 'c-a'),
        ('p-a2', 'Beans in the garden', 'Body', 'author', 'c-a'),
        ('p-b', 'Tomatoes in the kitchen', 'Body', 'author', 'c-b');
      INSERT INTO comments (id, post_id, author_id, content) VALUES
        ('m-a', 'p-a', 'author', 'Tomatoes need sun');`);
    // Many communities, so a scan would show in the plans.
    await connection.query(
      'INSERT INTO communities (id, creator_id, name) VALUES ?',
      [
        Array.from({ length: 500 }, (_, index) => [
          `seed-${index}`,
          'creator',
          `seed_${index}`,
        ]),
      ],
    );
    await connection.query('ANALYZE TABLE communities, posts');

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    const log = new CommunityModerationLogService(pool);
    const notifications = new NotificationsService(pool);
    admin = new AdminCommunitiesService(pool, new AuditLogService(pool));
    communities = new CommunitiesService(pool, accepting, log);
    rules = new CommunityRulesService(pool, accepting);
    stats = new CommunityStatsService(pool);
    posts = new PostsService(pool, notifications, accepting, log);
    comments = new CommentsService(pool, notifications, accepting);
    votes = new VotesService(pool, accepting);
    bans = new CommunityBansService(pool, log);
    search = new SearchService(pool);
    activity = new UserActivityService(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  // The predicate adds a filter to a lookup by key, never a scan.
  it.each([
    ['the community lookup by name', LISTED_COMMUNITY_ID_SQL, ['garden']],
    ['the content lookup through its post', THREAD_POST_SQL, ['p-a']],
  ])('serves %s by key', async (_name, sql, values) => {
    const plan = await rows(`EXPLAIN ${sql}`, values);
    for (const row of plan) {
      expect(row.type).not.toBe('ALL');
    }
  });

  it('decides concurrent suspensions once, auditing the one that won', async () => {
    const outcomes = await Promise.allSettled([
      admin.suspend('c-a', { reason: 'Spam network' }, 'admin'),
      admin.suspend('c-a', { reason: 'Spam network' }, 'admin'),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ConflictException);

    const audit = await rows(
      "SELECT action, target_type, target_id, metadata FROM admin_actions WHERE action = 'community_suspended'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      target_type: 'community',
      target_id: 'c-a',
    });
  });

  it('hides it from every role on every public read and write', async () => {
    await hiddenFrom(publicCalls);
    for (const actor of ['member', 'moderator', 'creator', 'admin']) {
      await hiddenFrom(callsFor(actor));
    }
    // The 404s wrote nothing.
    const written = await rows(
      `SELECT
         (SELECT COUNT(*) FROM community_subscriptions WHERE community_id = 'c-a') AS subscriptions,
         (SELECT COUNT(*) FROM community_moderators WHERE community_id = 'c-a') AS moderators,
         (SELECT COUNT(*) FROM community_bans) AS bans,
         (SELECT COUNT(*) FROM posts WHERE community_id = 'c-a') AS posts,
         (SELECT COUNT(*) FROM comments) AS comments,
         (SELECT COUNT(*) FROM votes) AS votes,
         (SELECT description FROM communities WHERE id = 'c-a') AS description`,
    );
    expect(written[0]).toEqual({
      subscriptions: 2,
      moderators: 1,
      bans: 0,
      posts: 2,
      comments: 1,
      votes: 0,
      description: 'Tomatoes and beans',
    });
  });

  it('omits it and its content from listings, search and activity', async () => {
    const listed = await communities.findAll({ limit: 100 });
    expect(listed.items.map((item) => item.name)).not.toContain('garden');
    expect(await searchNames('communities', 'tomatoes')).toEqual(['kitchen']);
    expect(await searchNames('posts', 'tomatoes')).toEqual(['p-b']);
    const authored = await activity.listPosts('author', {});
    expect(authored.items.map((item) => item.id)).toEqual(['p-b']);
  });

  it('keeps it for administrators', async () => {
    await expect(admin.findOne('c-a')).resolves.toMatchObject({
      id: 'c-a',
      suspension_reason: 'Spam network',
    });
    const suspended = await admin.findAll({ state: 'suspended' } as never);
    expect(suspended.items.map((item) => item.id)).toEqual(['c-a']);
  });

  it('restores it intact, keeping what was decided during the suspension', async () => {
    // A removal decided meanwhile, outside the public routes.
    await connection.query(
      "UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'admin', removal_reason = 'Spam' WHERE id = 'p-a2'",
    );
    await admin.restore('c-a', { restore_reason: 'Appeal upheld' }, 'admin');

    await expect(communities.findOne('garden')).resolves.toMatchObject({
      name: 'garden',
    });
    await expect(
      communities.getSubscription('garden', 'member'),
    ).resolves.toBeDefined();
    await expect(posts.findOne('p-a')).resolves.toMatchObject({ id: 'p-a' });
    expect(await searchNames('communities', 'tomatoes')).toContain('garden');
    const removed = await posts.findOne('p-a2', 'author');
    expect(removed).toMatchObject({ id: 'p-a2' });
    expect(
      (await rows("SELECT removed_at FROM posts WHERE id = 'p-a2'"))[0]
        .removed_at,
    ).not.toBeNull();
    // The moderator and the creator have their powers back.
    await posts.pin('p-a', 'moderator');
    await communities.update('garden', { description: 'Back' }, 'creator');

    const audit = await rows(
      "SELECT metadata FROM admin_actions WHERE action = 'community_restored'",
    );
    expect(audit).toHaveLength(1);
    const metadata = audit[0].metadata as Record<string, unknown> | string;
    expect(
      typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
    ).toEqual({ community_name: 'garden', restore_reason: 'Appeal upheld' });
  });
});
