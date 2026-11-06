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
import type { AuthService } from '../auth/auth.service';
import { PostsService } from '../posts/posts.service';
import { SavedPostsService, savedPostsSql } from '../posts/saved-posts.service';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { AccountDeletionService } from '../users/account-deletion.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '027_create_saved_posts';

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 027 undone: the saved_posts block and its version.
const preceding = snapshot
  .replace(
    /-- A user's private bookmarks \(027_create_saved_posts\)\.\r?\nCREATE TABLE saved_posts \([\s\S]*?\r?\n\);\r?\n/,
    '',
  )
  .replace(/,\r?\n\s*\('027_create_saved_posts'\)/, '');

// Saved posts against a real MySQL server: migration 027 through the real
// runner (applied once, then skipped, ending in the snapshot's schema), the
// cascades, the listing's filters and its count, the caller-dependent saved
// flag, and the listing's plan. Opt in with MYSQL_INTEGRATION_TEST=true and
// MYSQL_* credentials that may create and drop scratch databases; skipped
// otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('saved posts (MySQL)', () => {
  const database = `saved_posts_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let saved: SavedPostsService;
  let posts: PostsService;
  let firstRun: string[];
  let secondRun: string[];

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };

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

  const schema = async (name: string) => ({
    columns: await rows(
      `SELECT column_name AS name, column_type AS type,
              is_nullable AS nullable, column_default AS def
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'saved_posts'
       ORDER BY column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'saved_posts'
       GROUP BY index_name ORDER BY index_name`,
      [name],
    ),
    foreignKeys: await rows(
      `SELECT k.column_name AS name, k.referenced_table_name AS refers,
              r.delete_rule AS on_delete
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.constraint_schema
        AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = ? AND k.table_name = 'saved_posts'
       ORDER BY k.column_name`,
      [name],
    ),
  });

  const listedIds = async (userId: string, query = {}) =>
    (await saved.list(userId, { limit: 100, ...query })).items.map(
      (item) => item.post.id,
    );

  beforeAll(async () => {
    expect(preceding).not.toContain('saved_posts');
    expect(preceding).not.toContain(VERSION);

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
    firstRun = await migrate();
    secondRun = await migrate();

    // u1 saves 1,500 posts so the plan is decided on a real range; u2 saves
    // a few. c-hidden is suspended, c-gone deleted.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('u1', 'u1', 'u1@example.test', 'x'),
        ('u2', 'u2', 'u2@example.test', 'x'),
        ('author', 'author', 'author@example.test', 'x'),
        ('leaver', 'leaver', 'leaver@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c1', 'u1', 'one'), ('c-hidden', 'u1', 'hidden'), ('c-gone', 'u1', 'gone');
      UPDATE communities SET suspended_at = UTC_TIMESTAMP() WHERE id = 'c-hidden';
      UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = 'u1'
        WHERE id = 'c-gone';
      INSERT INTO posts (id, title, content, author_id, community_id)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1500)
        SELECT CONCAT('p', n), CONCAT('Post ', n), 'Body', 'author', 'c1' FROM seq;
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-suspended', 'S', 'Body', 'author', 'c-hidden'),
        ('p-deleted', 'D', 'Body', 'author', 'c-gone'),
        ('p-by-leaver', 'L', 'Body', 'leaver', 'c1');
      -- Saved in pairs a second apart, so the post_id tiebreaker decides.
      INSERT INTO saved_posts (user_id, post_id, created_at)
        SELECT 'u1', id,
               TIMESTAMP('2026-11-01 00:00:00') + INTERVAL FLOOR(CAST(SUBSTRING(id, 2) AS UNSIGNED) / 2) SECOND
        FROM posts WHERE id REGEXP '^p[0-9]+$';
      INSERT INTO saved_posts (user_id, post_id, created_at) VALUES
        ('u1', 'p-suspended', '2026-12-01 00:00:00'),
        ('u1', 'p-deleted', '2026-12-01 00:00:00'),
        ('u1', 'p-by-leaver', '2026-12-02 00:00:00'),
        ('u2', 'p1', '2026-11-05 00:00:00'),
        ('u2', 'p2', '2026-11-06 00:00:00');
      UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'u1'
        WHERE id IN ('p10', 'p20', 'p30');
      ANALYZE TABLE saved_posts, posts, communities;`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    saved = new SavedPostsService(pool);
    posts = new PostsService(
      pool,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
      {} as CommunityModerationLogService,
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  describe('migration 027', () => {
    it('applies once, then skips', () => {
      expect(firstRun).toEqual([`Applied ${VERSION}`]);
      expect(secondRun).toEqual([]);
    });

    it('matches the snapshot exactly', async () => {
      expect(await schema(database)).toEqual(await schema(fresh));
    });

    it('creates the composite key, the listing index and two cascading keys', async () => {
      const { indexes, foreignKeys } = await schema(database);
      expect(indexes).toEqual(
        expect.arrayContaining([
          { name: 'PRIMARY', columns: 'user_id,post_id' },
          {
            name: 'idx_saved_posts_user_created',
            columns: 'user_id,created_at,post_id',
          },
        ]),
      );
      expect(foreignKeys).toEqual([
        { name: 'post_id', refers: 'posts', on_delete: 'CASCADE' },
        { name: 'user_id', refers: 'users', on_delete: 'CASCADE' },
      ]);
    });
  });

  describe('saving', () => {
    it('is an idempotent upsert that keeps created_at', async () => {
      await saved.save('p1499', 'u2');
      const [first] = await rows(
        "SELECT created_at FROM saved_posts WHERE user_id = 'u2' AND post_id = 'p1499'",
      );
      await connection.query('DO SLEEP(1.1)');
      await saved.save('p1499', 'u2');
      const again = await rows(
        "SELECT created_at FROM saved_posts WHERE user_id = 'u2' AND post_id = 'p1499'",
      );
      expect(again).toEqual([first]);
      await saved.unsave('p1499', 'u2');
      await saved.unsave('p1499', 'u2');
    });

    it.each(['p10', 'p-suspended', 'p-deleted', 'no-such-post'])(
      'refuses to save %s with 404',
      async (id) => {
        await expect(saved.save(id, 'u2')).rejects.toMatchObject({
          status: 404,
        });
      },
    );
  });

  describe('the listing', () => {
    it('lists by save time, newest first, with the post_id tiebreaker, and reverses for oldest', async () => {
      const newest = await listedIds('u1');
      expect(newest.slice(0, 1)).toEqual(['p-by-leaver']);
      const expected = await rows(
        `SELECT s.post_id FROM saved_posts s JOIN posts p ON p.id = s.post_id
         JOIN communities c ON c.id = p.community_id
         WHERE s.user_id = 'u1' AND p.removed_at IS NULL
           AND c.deleted_at IS NULL AND c.suspended_at IS NULL
         ORDER BY s.created_at DESC, s.post_id DESC LIMIT 100`,
      );
      expect(newest).toEqual(expected.map((row) => String(row.post_id)));
      const oldest = await listedIds('u1', { sort: 'oldest' });
      expect(oldest.slice(0, 2)).toEqual(['p1', 'p2']);
    });

    it('omits removed posts and deleted or suspended communities, keeps a deleted author, and counts identically', async () => {
      const seen: string[] = [];
      const first = await saved.list('u1', { limit: 100 });
      // 1500 + p-by-leaver, minus the three removed.
      expect(first.total).toBe(1498);
      const pages = Math.ceil(first.total / 100);
      for (let page = 1; page <= pages; page += 1) {
        const result = await saved.list('u1', { page, limit: 100 });
        expect(result.items.length).toBeGreaterThan(0);
        seen.push(...result.items.map((item) => item.post.id));
      }
      expect(seen).toHaveLength(first.total);
      expect(new Set(seen).size).toBe(first.total);
      for (const hidden of ['p10', 'p20', 'p30', 'p-suspended', 'p-deleted']) {
        expect(seen).not.toContain(hidden);
      }

      // The author's account is anonymised, not deleted: the save stays.
      await connection.query(
        "UPDATE users SET username = 'deleted_leaver', deleted_at = UTC_TIMESTAMP() WHERE id = 'leaver'",
      );
      expect(await listedIds('u1')).toContain('p-by-leaver');
    });

    it('keeps the rows of omitted posts, so a restored post reappears', async () => {
      expect(
        await rows(
          "SELECT post_id FROM saved_posts WHERE user_id = 'u1' AND post_id = 'p10'",
        ),
      ).toHaveLength(1);
      await connection.query(
        "UPDATE posts SET removed_at = NULL, removed_by = NULL WHERE id = 'p10'",
      );
      const all: string[] = [];
      for (let page = 1; page <= 15; page += 1) {
        all.push(...(await listedIds('u1', { page })));
      }
      expect(all).toContain('p10');
      await connection.query(
        "UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'u1' WHERE id = 'p10'",
      );
    });

    it('never returns another account’s saves', async () => {
      expect(await listedIds('u2')).toEqual(['p2', 'p1']);
    });

    // Measured on MySQL 8.0: a ref on idx_saved_posts_user_created read in
    // index order (backwards for new), each post by primary key.
    it.each(['new', 'oldest'] as const)(
      'plans the listing on idx_saved_posts_user_created without a filesort (sort=%s)',
      async (sort) => {
        const plan = await rows(`EXPLAIN ${savedPostsSql(sort)}`, [
          'u1',
          20,
          40,
        ]);
        const savesRow = plan.find((row) => row.table === 's');
        expect(savesRow).toMatchObject({
          key: 'idx_saved_posts_user_created',
        });
        expect(plan.find((row) => row.table === 'p')).toMatchObject({
          key: 'PRIMARY',
        });
        for (const row of plan) {
          expect(String(row.Extra)).not.toContain('Using filesort');
        }
      },
    );
  });

  describe('the saved flag', () => {
    it('is true only for the caller’s own saves, and false when anonymous', async () => {
      const page = await posts.findAll({ community_id: 'c1', limit: 5 }, 'u2');
      const flags = Object.fromEntries(
        page.items.map((post) => [post.id, post.saved]),
      );
      const anonymous = await posts.findAll({ community_id: 'c1', limit: 5 });
      expect(anonymous.items.every((post) => post.saved === false)).toBe(true);
      await expect(posts.findOne('p1', 'u2')).resolves.toMatchObject({
        saved: true,
      });
      await expect(posts.findOne('p1', 'author')).resolves.toMatchObject({
        saved: false,
      });
      expect(Object.values(flags).every((flag) => flag === false)).toBe(true);
    });
  });

  describe('cascades', () => {
    it('removes a hard-deleted post’s saves and a deleted user’s saves', async () => {
      await connection.query("DELETE FROM posts WHERE id = 'p1500'");
      expect(
        await rows("SELECT user_id FROM saved_posts WHERE post_id = 'p1500'"),
      ).toEqual([]);

      await connection.query("DELETE FROM users WHERE id = 'u2'");
      expect(
        await rows("SELECT post_id FROM saved_posts WHERE user_id = 'u2'"),
      ).toEqual([]);
    });

    // Account deletion anonymises the row, so the cascade never fires
    // through the API; the service deletes the saves itself.
    it('clears the saves of an account deleted through the API', async () => {
      await connection.query(
        "INSERT INTO users (id, username, email, password_hash) VALUES ('self', 'self', 'self@example.test', 'x')",
      );
      await connection.query(
        "INSERT INTO saved_posts (user_id, post_id) VALUES ('self', 'p1')",
      );
      // Password checking and session revocation are AuthService's, tested
      // elsewhere; here only the private-state deletion matters.
      const deletion = new AccountDeletionService(pool, {
        passwordMatches: () => Promise.resolve(true),
        revokeAllSessions: () => Promise.resolve(),
      } as unknown as AuthService);
      await deletion.deleteOwnAccount('self', 'x');

      const [user] = await rows(
        "SELECT deleted_at FROM users WHERE id = 'self'",
      );
      expect(user.deleted_at).not.toBeNull();
      expect(
        await rows("SELECT post_id FROM saved_posts WHERE user_id = 'self'"),
      ).toEqual([]);
      // The post itself, and other users' saves of it, are untouched.
      expect(
        await rows("SELECT user_id FROM saved_posts WHERE post_id = 'p1'"),
      ).toEqual([{ user_id: 'u1' }]);
    });
  });
});
