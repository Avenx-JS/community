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
import { CommunitiesService } from '../communities/communities.service';
import { CommunityDiscoveryService } from '../communities/community-discovery.service';
import { CommunityFlairsService } from '../communities/community-flairs.service';
import { CommunityJoinRequestsService } from '../communities/community-join-requests.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { CommunityModeratorInvitesService } from '../communities/community-moderator-invites.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '038_add_community_settings';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 038 undone: its appended block, its actions in the
// moderation enum, and the version.
const preceding = snapshot
  .replace(
    /-- Community settings \(038_add_community_settings\)\.\r?\n[\s\S]*?(?=-- [^\n]*\(\d{3}_[a-z_]+\)\.\r?\n|CREATE TABLE schema_migrations)/,
    '',
  )
  .replace(
    /,\r?\n\s*'moderator_invited',\r?\n\s*'moderator_invite_revoked',\r?\n\s*'moderator_invite_declined',\r?\n\s*'join_request_approved',\r?\n\s*'join_request_denied'/,
    '',
  )
  .replace(/,\r?\n\s*\('038_add_community_settings'\)/, '');

// Migration 038 through the real runner over a database at 037 that holds a
// community and a post, then the settings with the real services on a real
// server. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials
// that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community settings (MySQL)', () => {
  const database = `community_settings_${randomBytes(4).toString('hex')}`;
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
  const notifications = {
    recordCommunityPost: () => Promise.resolve({ written: 0, recipients: 0 }),
  } as unknown as NotificationsService;
  let connection: Connection;
  let pool: Pool;
  let communities: CommunitiesService;
  let posts: PostsService;
  let joinRequests: CommunityJoinRequestsService;
  let invites: CommunityModeratorInvitesService;
  let flairs: CommunityFlairsService;
  let discovery: CommunityDiscoveryService;
  let firstRun: string[];

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
  const TABLES =
    "('communities', 'posts', 'community_join_requests', 'community_moderator_invites', 'community_flairs', 'community_user_flairs', 'community_mutes', 'community_moderation_actions')";
  const schema = async (name: string) => ({
    columns: await rows(
      `SELECT table_name AS t, column_name AS name, column_type AS type, is_nullable AS nullable, column_default AS def
       FROM information_schema.columns WHERE table_schema = ? AND table_name IN ${TABLES}
       ORDER BY table_name, column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT table_name AS t, index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics WHERE table_schema = ? AND table_name IN ${TABLES}
       GROUP BY table_name, index_name ORDER BY table_name, index_name`,
      [name],
    ),
    foreignKeys: await rows(
      `SELECT table_name AS t, constraint_name AS name, delete_rule AS onDelete
       FROM information_schema.referential_constraints WHERE constraint_schema = ? AND table_name IN ${TABLES}
       ORDER BY table_name, constraint_name`,
      [name],
    ),
  });

  beforeAll(async () => {
    expect(preceding).not.toMatch(
      /community_join_requests|allowed_post_types|moderator_invited/,
    );
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
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('creator', 'creator', 'creator@example.test', 'x'),
        ('member', 'member', 'member@example.test', 'x'),
        ('sam', 'sam', 'sam@example.test', 'x'),
        ('outsider', 'outsider', 'outsider@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES ('c-1', 'creator', 'garden');
      INSERT INTO community_subscriptions (user_id, community_id) VALUES ('member', 'c-1');
      INSERT INTO posts (id, title, content, type, author_id, community_id) VALUES
        ('p-1', 'Seed swap', 'Tomatoes', 'text', 'member', 'c-1');`);
    firstRun = await migrate();

    pool = createPool({ ...credentials, database, connectionLimit: 6 });
    const moderationLog = new CommunityModerationLogService(pool);
    communities = new CommunitiesService(pool, accepting, moderationLog);
    posts = new PostsService(pool, notifications, accepting, moderationLog);
    joinRequests = new CommunityJoinRequestsService(
      pool,
      accepting,
      moderationLog,
    );
    invites = new CommunityModeratorInvitesService(pool, moderationLog);
    flairs = new CommunityFlairsService(pool);
    discovery = new CommunityDiscoveryService(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  it('applies 038, matching a fresh installation, with existing communities public', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await schema(database)).toEqual(await schema(fresh));
    expect(
      (
        await rows(
          "SELECT visibility, nsfw, allowed_post_types FROM communities WHERE id = 'c-1'",
        )
      )[0],
    ).toEqual({
      visibility: 'public',
      nsfw: 0,
      allowed_post_types: 'text,link,media',
    });
  });

  it('hides a private community from non-members at once, and keeps it for members', async () => {
    await communities.update('garden', { visibility: 'private' }, 'creator');

    await expect(posts.findOne('p-1', 'outsider')).rejects.toMatchObject({
      status: 404,
    });
    await expect(posts.findOne('p-1')).rejects.toMatchObject({ status: 404 });
    await expect(posts.findOne('p-1', 'member')).resolves.toMatchObject({
      id: 'p-1',
    });
    expect((await posts.findAll({}, 'outsider')).total).toBe(0);
    expect((await posts.findAll({}, 'member')).total).toBe(1);
    await expect(
      communities.resolveListedId('garden', 'outsider'),
    ).rejects.toMatchObject({ response: { reason: 'private_community' } });
    expect(
      (
        await rows(
          "SELECT action, metadata FROM community_moderation_actions WHERE community_id = 'c-1'",
        )
      ).map((row) => row.action as string),
    ).toContain('community_updated');
  });

  it('joins by an approved request only', async () => {
    await expect(communities.subscribe('garden', 'sam')).rejects.toMatchObject({
      response: { reason: 'join_request_required' },
    });
    await joinRequests.create('garden', 'sam', { message: 'Hi' });
    await joinRequests.approve('garden', 'sam', 'creator');
    await expect(posts.findOne('p-1', 'sam')).resolves.toMatchObject({
      id: 'p-1',
    });
  });

  it('makes a moderator only through an accepted invitation', async () => {
    await invites.invite('garden', 'member', 'creator');
    expect(
      await rows("SELECT * FROM community_moderators WHERE user_id = 'member'"),
    ).toEqual([]);
    await invites.accept('garden', 'member');
    expect(
      await rows("SELECT * FROM community_moderators WHERE user_id = 'member'"),
    ).toHaveLength(1);
    expect(
      (
        await rows(
          "SELECT action FROM community_moderation_actions WHERE target_id = 'member' ORDER BY created_at, id",
        )
      ).map((row) => row.action as string),
    ).toEqual(expect.arrayContaining(['moderator_invited', 'moderator_added']));
  });

  it('clears a deleted flair from its posts, keeping the posts', async () => {
    const flair = await flairs.create('garden', 'creator', {
      kind: 'post',
      text: 'News',
    });
    await flairs.setPostFlair('p-1', flair.id, 'member');
    await expect(posts.findOne('p-1', 'member')).resolves.toMatchObject({
      flair: { id: flair.id, text: 'News' },
    });
    await flairs.remove('garden', flair.id, 'creator');
    await expect(posts.findOne('p-1', 'member')).resolves.toMatchObject({
      flair: null,
    });
  });

  it('hides nsfw communities without the opt-in, and muted ones from the feed', async () => {
    await communities.update(
      'garden',
      { visibility: 'public', nsfw: true },
      'creator',
    );
    expect((await posts.findAll({}, 'outsider')).total).toBe(0);
    await connection.query(
      "INSERT INTO user_preferences (user_id, show_nsfw) VALUES ('outsider', TRUE)",
    );
    expect((await posts.findAll({}, 'outsider')).total).toBe(1);

    await connection.query(
      "INSERT INTO user_preferences (user_id, show_nsfw) VALUES ('member', TRUE)",
    );
    expect((await posts.findFeed({}, 'member')).total).toBe(1);
    await discovery.mute('garden', 'member');
    expect((await posts.findFeed({}, 'member')).total).toBe(0);
    expect((await discovery.trending({ limit: 10 }, 'member')).items).toEqual(
      [],
    );
  });
});
