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
import { CommentsService } from '../comments/comments.service';
import { CommunityBanPolicyService } from '../communities/community-ban-policy.service';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { MentionService } from '../notifications/mention.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { UserAutocompleteService } from '../users/user-autocomplete.service';
import { UserBlockPolicyService } from '../users/user-block-policy.service';
import { snapshotBefore } from './enum-history';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '045_add_mentions';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 045 and every later folded migration undone
// (enum-history.ts); the runner then applies them in order.
const preceding = snapshotBefore(snapshot, '045');

// Migration 045 through the real runner, then posts and comments with
// mentions through the real services, and the autocomplete, on a real
// server. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials
// that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('mentions (MySQL)', () => {
  const database = `mentions_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
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
  let autocomplete: UserAutocompleteService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const mentioned = (subjectId: string) =>
    rows(
      "SELECT recipient_id FROM notifications WHERE type = 'mention' AND subject_id = ? ORDER BY recipient_id",
      [subjectId],
    ).then((found) => found.map((row) => row.recipient_id as string));
  const schema = (name: string) =>
    rows(
      `SELECT table_name AS t, column_name AS c, column_type AS type, column_default AS def
       FROM information_schema.columns
       WHERE table_schema = ? AND ((table_name = 'notifications' AND column_name = 'type')
         OR (table_name = 'user_preferences' AND column_name = 'notify_mentions'))
       UNION ALL
       SELECT table_name, index_name, GROUP_CONCAT(column_name), NULL
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'users' AND index_name = 'idx_users_display_name'
       GROUP BY table_name, index_name
       ORDER BY 1, 2`,
      [name, name],
    );

  beforeAll(async () => {
    expect(preceding).not.toMatch(/notify_mentions|'mention'/);
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
    const log: string[] = [];
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
    await runMigrations(runner, await loadMigrations(migrations), (line) =>
      log.push(line),
    );
    firstRun = log.filter((line) => !line.startsWith('Skipped'));

    await connection.query(`
      INSERT INTO users (id, username, email, password_hash, display_name) VALUES
        ('author', 'author', 'author@example.test', 'x', 'The Author'),
        ('alice', 'alice', 'alice@example.test', 'x', 'Alice Maintainer'),
        ('member', 'member', 'member@example.test', 'x', NULL),
        ('outsider', 'outsider', 'outsider@example.test', 'x', NULL),
        ('blocker', 'blocker', 'blocker@example.test', 'x', NULL),
        ('blocked', 'blocked', 'blocked@example.test', 'x', NULL),
        ('banned', 'banned', 'banned@example.test', 'x', NULL),
        ('quiet', 'quiet', 'quiet@example.test', 'x', NULL),
        ('poster', 'poster', 'poster@example.test', 'x', NULL);
      INSERT INTO users (id, username, email, password_hash, deleted_at)
        VALUES ('gone', 'gone_user', 'gone@example.test', 'x', UTC_TIMESTAMP());
      INSERT INTO communities (id, creator_id, name, visibility) VALUES
        ('k-pub', 'poster', 'garden', 'public'),
        ('k-priv', 'poster', 'secret', 'private');
      INSERT INTO community_subscriptions (user_id, community_id) VALUES
        ('author', 'k-pub'), ('author', 'k-priv'), ('member', 'k-priv'), ('alice', 'k-priv');
      INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('blocker', 'author'), ('author', 'blocked');
      INSERT INTO community_bans (id, community_id, user_id, reason) VALUES ('b-1', 'k-pub', 'banned', 'Spam');
      INSERT INTO user_preferences (user_id, email_notifications, new_community_notifications, show_nsfw, timezone, language, push_notifications, notify_mentions)
        VALUES ('quiet', TRUE, TRUE, FALSE, 'UTC', 'en', TRUE, FALSE);
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-pub', 'Tomatoes', 'Body', 'poster', 'k-pub'),
        ('p-priv', 'Secret tomatoes', 'Body', 'poster', 'k-priv');`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    const notifications = new NotificationsService(pool);
    const mentions = new MentionService(pool, notifications);
    const accepted = {
      assertAcceptedOrThrow: () => Promise.resolve(),
    } as unknown as CommunityRuleAcceptanceService;
    const bans = new CommunityBanPolicyService(pool);
    comments = new CommentsService(
      pool,
      notifications,
      accepted,
      new UserBlockPolicyService(pool),
      bans,
      mentions,
    );
    posts = new PostsService(
      pool,
      notifications,
      accepted,
      {} as CommunityModerationLogService,
      bans,
      undefined,
      mentions,
    );
    autocomplete = new UserAutocompleteService(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  it('applies 045, matching a fresh installation', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await schema(database)).toEqual(await schema(fresh));
  });

  it('notifies only the eligible accounts a comment mentions, once each, naming the author', async () => {
    const comment = await comments.create(
      'p-pub',
      {
        content:
          '@alice @ALICE @member @outsider @blocker @blocked @banned @quiet @gone_user @author @nobody',
      },
      'author',
    );
    // Not: the author, a block either way, the community ban, notify_mentions
    // off, a deleted account, an unknown name.
    expect(await mentioned(comment.id)).toEqual([
      'alice',
      'member',
      'outsider',
    ]);
    expect(
      await rows(
        "SELECT actor_id, subject_type, community_id, metadata FROM notifications WHERE type = 'mention' AND recipient_id = 'alice'",
      ),
    ).toEqual([
      {
        actor_id: 'author',
        subject_type: 'comment',
        community_id: 'k-pub',
        metadata: expect.objectContaining({
          actor_username: 'author',
          community_name: 'garden',
          post_id: 'p-pub',
        }),
      },
    ]);
  });

  it('notifies no non-member of a private community', async () => {
    const comment = await comments.create(
      'p-priv',
      { content: '@alice @member @outsider' },
      'author',
    );
    expect(await mentioned(comment.id)).toEqual(['alice', 'member']);
  });

  it('does not double the post_comment of the post author, nor read code', async () => {
    const comment = await comments.create(
      'p-pub',
      { content: '@poster look\n```\n@alice\n```\n`@member`' },
      'author',
    );
    expect(await mentioned(comment.id)).toEqual([]);
    expect(
      await rows(
        "SELECT type FROM notifications WHERE recipient_id = 'poster' AND subject_id = ?",
        [comment.id],
      ),
    ).toEqual([{ type: 'post_comment' }]);
  });

  it('on an edit notifies only the mentions it adds, and never twice', async () => {
    const comment = await comments.create(
      'p-pub',
      { content: 'thanks @alice' },
      'author',
    );
    await comments.update(
      comment.id,
      { content: 'thanks @alice and @member' },
      'author',
    );
    await comments.update(comment.id, { content: 'thanks @member' }, 'author');
    await comments.update(
      comment.id,
      { content: 'thanks @alice @member' },
      'author',
    );
    expect(await mentioned(comment.id)).toEqual(['alice', 'member']);
    expect(
      await rows(
        "SELECT COUNT(*) AS n FROM notifications WHERE type = 'mention' AND subject_id = ?",
        [comment.id],
      ),
    ).toEqual([{ n: 2 }]);
  });

  it('reads a post from its title and content, and an edit of it the same way', async () => {
    const post = await posts.create(
      {
        community_id: 'k-pub',
        type: 'text',
        title: '@alice, a question',
        content: 'and @member',
      } as never,
      'author',
    );
    expect(await mentioned(post.id)).toEqual(['alice', 'member']);
    await posts.update(
      post.id,
      { content: 'and @member, @outsider' },
      'author',
    );
    expect(await mentioned(post.id)).toEqual(['alice', 'member', 'outsider']);
  });

  it('considers at most the first 10 names', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `many_${i}`);
    await connection.query(
      `INSERT INTO users (id, username, email, password_hash) VALUES ${names
        .map((name) => `('${name}', '${name}', '${name}@example.test', 'x')`)
        .join(', ')}`,
    );
    const comment = await comments.create(
      'p-pub',
      { content: names.map((name) => `@${name}`).join(' ') },
      'author',
    );
    expect((await mentioned(comment.id)).sort()).toEqual(
      names.slice(0, 10).sort(),
    );
  });

  it('suggests by username or display-name prefix, never deleted, the caller or a block', async () => {
    expect(
      (await autocomplete.suggest('author', 'al')).items.map((i) => i.username),
    ).toEqual(['alice']);
    expect((await autocomplete.suggest('author', 'Alice Main')).items).toEqual([
      { username: 'alice', display_name: 'Alice Maintainer', avatar_url: null },
    ]);
    for (const prefix of ['blocke', 'gone', 'auth']) {
      expect((await autocomplete.suggest('author', prefix)).items).toEqual([]);
    }
    expect((await autocomplete.suggest('author', 'many')).items).toHaveLength(
      10,
    );
  });
});
