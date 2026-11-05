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
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// PATCH /posts/:id and PATCH /comments/:id against a real MySQL server. The
// point of editing is that it is not delete-and-repost: the post's id,
// created_at, comments (comments.post_id ON DELETE CASCADE) and votes
// survive, and so does a comment's reply chain (comments.parent_id ON DELETE
// CASCADE). edited_at comes from the database clock, and a no-op edit leaves
// it NULL. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials
// that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('content editing (MySQL)', () => {
  const database = `content_editing_${randomBytes(4).toString('hex')}`;
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
  // Editing must never consult the rule gate.
  const refusingRules = {
    assertAcceptedOrThrow: () =>
      Promise.reject(new Error('rule gate consulted')),
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
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('author', 'author', 'author@example.test', 'x'),
        ('mod', 'mod', 'mod@example.test', 'x'),
        ('voter', 'voter', 'voter@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c1', 'mod', 'one'), ('c-suspended', 'mod', 'suspended');
      UPDATE communities SET suspended_at = UTC_TIMESTAMP() WHERE id = 'c-suspended';
      INSERT INTO posts (id, title, content, type, author_id, community_id, created_at) VALUES
        ('p-text', 'Title', 'Body', 'text', 'author', 'c1', '2026-01-01 08:00:00'),
        ('p-link', 'Link', 'https://example.com/a', 'link', 'author', 'c1', '2026-01-01 08:00:00'),
        ('p-suspended', 'Hidden', 'Body', 'text', 'author', 'c-suspended', '2026-01-01 08:00:00');
      INSERT INTO comments (id, post_id, author_id, parent_id, content) VALUES
        ('m-root', 'p-text', 'author', NULL, 'Root'),
        ('m-reply', 'p-text', 'voter', 'm-root', 'Reply'),
        ('m-nested', 'p-text', 'author', 'm-reply', 'Nested');
      INSERT INTO votes (id, user_id, target_type, target_id, value) VALUES
        ('v1', 'voter', 'post', 'p-text', 1),
        ('v2', 'mod', 'post', 'p-text', 1),
        ('v3', 'voter', 'comment', 'm-root', -1);`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    posts = new PostsService(
      pool,
      {} as NotificationsService,
      refusingRules,
      {} as CommunityModerationLogService,
    );
    comments = new CommentsService(
      pool,
      {} as NotificationsService,
      refusingRules,
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('edits a post in place, keeping its id, created_at, comments and votes', async () => {
    const [before] = await rows(
      "SELECT id, created_at, edited_at FROM posts WHERE id = 'p-text'",
    );
    expect(before.edited_at).toBeNull();
    const [{ now }] = await rows('SELECT UTC_TIMESTAMP() AS now');

    const edited = await posts.update(
      'p-text',
      { title: 'Corrected', content: 'Better body' },
      'author',
    );

    expect(edited).toMatchObject({
      id: 'p-text',
      title: 'Corrected',
      content: 'Better body',
      created_at: new Date(before.created_at as Date).toISOString(),
      score: 2,
    });
    expect(edited.edited_at).not.toBeNull();
    // From the database clock, not the application's.
    expect(
      Math.abs(
        new Date(edited.edited_at!).getTime() - new Date(now as Date).getTime(),
      ),
    ).toBeLessThan(60_000);
    expect(
      await rows(
        "SELECT id FROM comments WHERE post_id = 'p-text' ORDER BY id",
      ),
    ).toHaveLength(3);
    expect(
      await rows(
        "SELECT id FROM votes WHERE target_type = 'post' AND target_id = 'p-text'",
      ),
    ).toHaveLength(2);
  });

  it('leaves edited_at untouched by a no-op edit', async () => {
    const result = await posts.update(
      'p-link',
      { title: 'Link', content: 'https://example.com/a' },
      'author',
    );
    expect(result.edited_at).toBeNull();
    const [row] = await rows("SELECT edited_at FROM posts WHERE id = 'p-link'");
    expect(row.edited_at).toBeNull();
  });

  it("validates a link post's content against its stored type", async () => {
    await expect(
      posts.update('p-link', { content: 'not a url' }, 'author'),
    ).rejects.toMatchObject({ status: 400 });
    const [row] = await rows("SELECT content FROM posts WHERE id = 'p-link'");
    expect(row.content).toBe('https://example.com/a');
  });

  it('edits a comment in place, keeping its replies and votes', async () => {
    const edited = await comments.update(
      'm-root',
      { content: 'Root, corrected' },
      'author',
    );
    expect(edited).toMatchObject({
      id: 'm-root',
      content: 'Root, corrected',
      reply_count: 1,
      score: -1,
    });
    expect(edited.edited_at).not.toBeNull();
    const chain = await rows(
      "SELECT id, parent_id FROM comments WHERE id IN ('m-reply', 'm-nested') ORDER BY id",
    );
    expect(chain).toEqual([
      expect.objectContaining({ id: 'm-nested', parent_id: 'm-reply' }),
      expect.objectContaining({ id: 'm-reply', parent_id: 'm-root' }),
    ]);
  });

  it('refuses the community creator, and answers 404 in a suspended community', async () => {
    await expect(
      posts.update('p-text', { title: 'Mod rewrite' }, 'mod'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      comments.update('m-root', { content: 'Mod rewrite' }, 'mod'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      posts.update('p-suspended', { title: 'T' }, 'author'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a comment on a locked post with 409, while the post itself stays editable', async () => {
    await connection.query(
      "UPDATE posts SET locked_at = UTC_TIMESTAMP(), locked_by = 'mod' WHERE id = 'p-text'",
    );
    await expect(
      comments.update('m-nested', { content: 'x' }, 'author'),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      posts.update('p-text', { title: 'Still mine' }, 'author'),
    ).resolves.toMatchObject({ title: 'Still mine' });
  });

  it('refuses a removed post with 409', async () => {
    await connection.query(
      "UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'mod' WHERE id = 'p-link'",
    );
    await expect(
      posts.update('p-link', { title: 'Rewrite' }, 'author'),
    ).rejects.toMatchObject({ status: 409 });
  });
});
