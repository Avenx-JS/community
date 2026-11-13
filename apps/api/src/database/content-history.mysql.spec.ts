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
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { ContentRevisionsService } from '../posts/content-revisions.service';
import { HiddenPostsService } from '../posts/hidden-posts.service';
import { PostLabelsService } from '../posts/post-labels.service';
import { PostsService } from '../posts/posts.service';
import { SavedCommentsService } from '../posts/saved-comments.service';
import { VoteHistoryService } from '../posts/vote-history.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '039_add_content_labels_and_history';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 039 undone: its appended block and the version.
const preceding = snapshot
  .replace(
    /-- Content labels, hidden posts, saved comments and revisions \(039_add_content_labels_and_history\)\.\r?\n[\s\S]*?(?=-- [^\n]*\(\d{3}_[a-z_]+\)\.\r?\n|CREATE TABLE schema_migrations)/,
    '',
  )
  .replace(/,\r?\n\s*\('039_add_content_labels_and_history'\)/, '');

// Migration 039 through the real runner over a database at 038 with a post
// that was edited before history existed, then the new routes' services on
// a real server. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_*
// credentials that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('content labels and history (MySQL)', () => {
  const database = `content_history_${randomBytes(4).toString('hex')}`;
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
  let labels: PostLabelsService;
  let hidden: HiddenPostsService;
  let saved: SavedCommentsService;
  let votes: VoteHistoryService;
  let revisions: ContentRevisionsService;
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
    "('posts', 'votes', 'hidden_posts', 'saved_comments', 'post_revisions', 'comment_revisions')";
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
  });

  beforeAll(async () => {
    expect(preceding).not.toMatch(/hidden_posts|post_revisions|nsfw_set_by/);
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
    // p-1 was edited before 039: its earlier text is gone.
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('author', 'author', 'author@example.test', 'x'),
        ('reader', 'reader', 'reader@example.test', 'x'),
        ('mod', 'mod', 'mod@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES ('c-1', 'mod', 'garden');
      INSERT INTO posts (id, title, content, type, author_id, community_id, edited_at) VALUES
        ('p-1', 'Edited before', 'Body', 'text', 'author', 'c-1', UTC_TIMESTAMP()),
        ('p-2', 'Fresh', 'Body', 'text', 'author', 'c-1', NULL);
      INSERT INTO comments (id, post_id, author_id, content) VALUES
        ('k-1', 'p-2', 'author', 'First');
      INSERT INTO votes (id, user_id, target_type, target_id, value) VALUES
        ('v-1', 'reader', 'post', 'p-2', 1),
        ('v-2', 'reader', 'comment', 'k-1', -1);`);
    firstRun = await migrate();

    pool = createPool({ ...credentials, database, connectionLimit: 6 });
    const moderationLog = new CommunityModerationLogService(pool);
    posts = new PostsService(
      pool,
      {} as NotificationsService,
      accepting,
      moderationLog,
    );
    comments = new CommentsService(pool, {} as NotificationsService, accepting);
    labels = new PostLabelsService(pool);
    hidden = new HiddenPostsService(pool);
    saved = new SavedCommentsService(pool);
    votes = new VoteHistoryService(pool);
    revisions = new ContentRevisionsService(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  it('applies 039, matching a fresh installation, with existing posts unlabelled', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await schema(database)).toEqual(await schema(fresh));
    expect(
      await rows(
        'SELECT id FROM posts WHERE nsfw_set_by IS NOT NULL OR spoiler_set_by IS NOT NULL',
      ),
    ).toEqual([]);
  });

  it('starts history at the migration, and keeps every later version', async () => {
    await expect(
      revisions.forPost('p-1', undefined, {}),
    ).resolves.toMatchObject({ items: [], complete: false });

    await posts.update('p-2', { title: 'Fresh, edited' }, 'author');
    await comments.update('k-1', { content: 'Second' }, 'author');
    await expect(
      revisions.forPost('p-2', undefined, {}),
    ).resolves.toMatchObject({
      current: { title: 'Fresh, edited', edited: true },
      items: [{ title: 'Fresh' }],
      complete: true,
    });
    await expect(
      revisions.forComment('k-1', 'reader', {}),
    ).resolves.toMatchObject({
      current: { content: 'Second' },
      items: [{ content: 'First' }],
      complete: true,
    });
  });

  it("keeps a moderator's label from the author", async () => {
    await labels.set('p-2', 'nsfw', 'mod');
    await expect(labels.clear('p-2', 'nsfw', 'author')).rejects.toMatchObject({
      status: 403,
    });
    await expect(posts.findOne('p-2')).resolves.toMatchObject({ nsfw: true });
  });

  it("hides a post from the caller's listing only", async () => {
    await hidden.hide('p-2', 'reader');
    const ids = async (viewer?: string) =>
      (await posts.findAll({}, viewer)).items.map((post) => post.id);
    expect(await ids('reader')).toEqual(['p-1']);
    expect(await ids('author')).toEqual(['p-2', 'p-1']);
    await expect(posts.findOne('p-2', 'reader')).resolves.toMatchObject({
      id: 'p-2',
    });
    expect((await hidden.list('reader', {})).total).toBe(1);
  });

  it('lists own votes, and drops saved comments and history with the comment', async () => {
    expect((await votes.list('reader', 1, {})).total).toBe(1);
    expect(
      (await votes.list('reader', -1, { type: 'comments' })).items,
    ).toHaveLength(1);

    await saved.save('k-1', 'reader');
    expect((await saved.list('reader', {})).total).toBe(1);
    await comments.remove('k-1', 'author');
    expect(await rows('SELECT * FROM saved_comments')).toEqual([]);
    expect(await rows('SELECT * FROM comment_revisions')).toEqual([]);
  });
});
