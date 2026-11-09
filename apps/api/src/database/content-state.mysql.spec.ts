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
import { visibleCommunitySql } from '../common/community-visibility';
import {
  POST_COLUMNS,
  PostsService,
  toPostDto,
  type PostRow,
} from '../posts/posts.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { removeTriggerRules, runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '017_add_post_and_comment_content_state';
const STATE_COLUMN =
  /^.*\b(edited_at|locked_at|locked_by|removed_at|removed_by|removal_reason)\b.*\r?\n/gm;

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 017 undone: its four trigger pairs, every line naming a
// content-state column and
// the 017 version removed, then the trailing comma that leaves before ");".
// Only posts and comments use these column names.
const preceding = removeTriggerRules(
  snapshot,
  'chk_posts_lock',
  'chk_posts_removal',
  'chk_comments_lock',
  'chk_comments_removal',
)
  .replace(STATE_COLUMN, '')
  .replace(/,(\s*\r?\n\);)/g, '$1')
  .replace(/,\r?\n\s*\('017_add_post_and_comment_content_state'\)/, '');

// Runs migration 017 through the real runner on a real MySQL server, over a
// seeded database at version 016. Opt in with MYSQL_INTEGRATION_TEST=true and
// MYSQL_* credentials that may create and drop scratch databases; skipped
// otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('post and comment content state (MySQL)', () => {
  const database = `content_state_${randomBytes(4).toString('hex')}`;
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
  let responsesBefore: unknown;

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
    return log;
  };

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };

  // What the public read endpoints return for the seeded content.
  const responses = async () => ({
    list: await posts.findAll({ limit: 100 }),
    post: await posts.findOne('p1'),
    thread: await comments.findThread('p1'),
  });

  // Columns, named indexes, foreign-key rules and checks of one table.
  const shape = async (schema: string, table: string) => ({
    columns: await rows(
      `SELECT column_name AS name, column_type AS type,
              is_nullable AS nullable, column_default AS default_value
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY column_name`,
      [schema, table],
    ),
    indexes: await rows(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = ? AND index_name LIKE 'idx\\_%'
       GROUP BY index_name ORDER BY index_name`,
      [schema, table],
    ),
    foreignKeys: await rows(
      `SELECT k.constraint_name AS name, k.column_name AS column_name,
              r.delete_rule AS on_delete
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.table_schema
        AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = ? AND k.table_name = ?
         AND k.constraint_name LIKE 'fk\\_%'
       ORDER BY k.constraint_name`,
      [schema, table],
    ),
    // The lock and removal rules are triggers, not CHECKs: MySQL 8 forbids a
    // CHECK on a column whose foreign key is ON DELETE SET NULL. Compared by
    // name, not ACTION_ORDER: rebuilding history puts later migrations'
    // triggers first, and independent BEFORE checks do not depend on order.
    triggers: await rows(
      `SELECT trigger_name AS name, action_timing AS timing,
              event_manipulation AS event, action_statement AS statement
       FROM information_schema.triggers
       WHERE event_object_schema = ? AND event_object_table = ?
       ORDER BY trigger_name`,
      [schema, table],
    ),
  });

  beforeAll(async () => {
    expect(preceding).not.toMatch(STATE_COLUMN);
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

    // 200 posts and 200 comments so a removed_at lookup is worth an index,
    // plus a two-level thread on p1.
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('author', 'author', 'author@example.test', 'x'),
        ('moderator', 'moderator', 'moderator@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES ('c1', 'author', 'c1');
      INSERT INTO posts (id, title, content, author_id, community_id, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
        SELECT CONCAT('p', n), CONCAT('Post ', n), 'Body', 'author', 'c1',
               TIMESTAMP('2026-01-01 00:00:00') + INTERVAL n MINUTE
        FROM seq;
      INSERT INTO comments (id, post_id, author_id, parent_id, content, created_at) VALUES
        ('m1', 'p1', 'author', NULL, 'Root', '2026-02-01 00:00:00'),
        ('m2', 'p1', 'author', 'm1', 'Reply', '2026-02-01 00:01:00');
      INSERT INTO comments (id, post_id, author_id, content)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
        SELECT CONCAT('bulk-', n), 'p200', 'author', 'Bulk' FROM seq;`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    // The read paths consult neither notifications nor rule acceptance.
    posts = new PostsService(
      pool,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
      {} as CommunityModerationLogService,
    );
    comments = new CommentsService(
      pool,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
    );
    // Before 017 the listing cannot run as the service now issues it: its
    // removed-post predicate names posts.removed_at, which 017 adds. The
    // baseline therefore runs the listing as it was before that predicate
    // (same columns, filter and order, rendered by the same DTO mapper); the
    // detail and thread reads do not name the new columns and run as is.
    responsesBefore = {
      list: await legacyListing(),
      post: await posts.findOne('p1'),
      thread: await comments.findThread('p1'),
    };
  }, 120_000);

  const legacyListing = async () => {
    const where = ` WHERE ${visibleCommunitySql('posts.community_id')}`;
    const [items] = await pool.execute<PostRow[]>(
      `SELECT ${POST_COLUMNS} FROM posts${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [100, 0],
    );
    const [counts] = await pool.execute<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total FROM posts${where}`,
    );
    return {
      // No votes and an anonymous reader: score 0, saved false.
      items: items.map((item) => toPostDto(item, 0, false)),
      page: 1,
      limit: 100,
      total: counts[0].total,
      sort: 'new',
    };
  };

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  it('applies 017 to a database at 016 once, and skips it on a second run', async () => {
    const first = await migrate();
    expect(first.filter((line) => !line.startsWith('Skipped'))).toEqual([
      `Applied ${VERSION}`,
    ]);
    const second = await migrate();
    expect(second.filter((line) => !line.startsWith('Skipped'))).toEqual([]);

    const [recorded] = await rows(
      'SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?',
      [VERSION],
    );
    expect(Number(recorded.n)).toBe(1);
  }, 60_000);

  it('leaves the public read responses byte-identical', async () => {
    const after = await responses();
    expect(JSON.stringify(after)).toBe(JSON.stringify(responsesBefore));
  });

  it.each(['posts', 'comments'])(
    'reads every existing row in %s as unedited, unlocked and present',
    async (table) => {
      const [state] = await rows(
        `SELECT COUNT(*) AS total,
                SUM(edited_at IS NULL AND locked_at IS NULL AND locked_by IS NULL
                    AND removed_at IS NULL AND removed_by IS NULL
                    AND removal_reason IS NULL) AS pristine
         FROM ${table}`,
      );
      expect(Number(state.total)).toBeGreaterThan(0);
      expect(Number(state.pristine)).toBe(Number(state.total));
    },
  );

  it.each(['posts', 'comments'])(
    'gives %s the expected columns, keys and checks, as the snapshot does',
    async (table) => {
      const migrated = await shape(database, table);

      expect(migrated.columns).toEqual(
        expect.arrayContaining(
          [
            ['edited_at', 'timestamp'],
            ['locked_at', 'timestamp'],
            ['locked_by', 'varchar(36)'],
            ['removal_reason', 'text'],
            ['removed_at', 'timestamp'],
            ['removed_by', 'varchar(36)'],
          ].map(([name, type]) => ({
            name,
            type,
            nullable: 'YES',
            default_value: null,
          })),
        ),
      );
      expect(migrated.indexes).toEqual(
        expect.arrayContaining([
          { name: `idx_${table}_removed_at`, columns: 'removed_at' },
        ]),
      );
      // 017's own keys; posts also has fk_posts_pinned_by from 026.
      expect(
        migrated.foreignKeys.filter((key) =>
          /_(locked|removed)_by$/.test(String(key.name)),
        ),
      ).toEqual([
        {
          name: `fk_${table}_locked_by`,
          column_name: 'locked_by',
          on_delete: 'SET NULL',
        },
        {
          name: `fk_${table}_removed_by`,
          column_name: 'removed_by',
          on_delete: 'SET NULL',
        },
      ]);
      expect(
        migrated.triggers
          .map((trigger) => trigger.name as string)
          .filter((name) => /_(lock|removal)_/.test(name)),
      ).toEqual([
        `trg_${table}_lock_insert`,
        `trg_${table}_lock_update`,
        `trg_${table}_removal_insert`,
        `trg_${table}_removal_update`,
      ]);
      expect(
        migrated.triggers.every((trigger) => trigger.timing === 'BEFORE'),
      ).toBe(true);

      await expect(shape(fresh, table)).resolves.toEqual(migrated);
    },
  );

  describe.each([
    ['posts', 'p2'],
    ['comments', 'm2'],
  ])('check constraints on %s', (table, id) => {
    const update = (assignments: string) =>
      connection.query(`UPDATE ${table} SET ${assignments} WHERE id = ?`, [id]);
    const reset = () =>
      update(
        'locked_at = NULL, locked_by = NULL, removed_at = NULL, removed_by = NULL, removal_reason = NULL',
      );

    it.each([
      ['locked_by without locked_at', "locked_by = 'moderator'", 'lock'],
      ['removed_by without removed_at', "removed_by = 'moderator'", 'removal'],
      [
        'removal_reason without removed_at',
        "removal_reason = 'Spam'",
        'removal',
      ],
    ])('rejects %s', async (_case, assignments, check) => {
      await expect(update(assignments)).rejects.toThrow(
        new RegExp(`chk_${table}_${check}`),
      );
    });

    it('accepts each timestamp alone and with its actor and reason', async () => {
      await update('locked_at = UTC_TIMESTAMP()');
      await update("locked_by = 'moderator'");
      await update('removed_at = UTC_TIMESTAMP()');
      await update("removed_by = 'moderator', removal_reason = 'Spam'");
      await reset();
    });
  });

  it('keeps the state when the acting account is deleted, nulling only the actor', async () => {
    await connection.query(`
      UPDATE posts SET locked_at = '2026-03-01 00:00:00', locked_by = 'moderator',
        removed_at = '2026-03-02 00:00:00', removed_by = 'moderator',
        removal_reason = 'Spam' WHERE id = 'p3';
      UPDATE comments SET locked_at = '2026-03-01 00:00:00', locked_by = 'moderator',
        removed_at = '2026-03-02 00:00:00', removed_by = 'moderator'
        WHERE id = 'm1';`);

    await connection.query("DELETE FROM users WHERE id = 'moderator'");

    const [post] = await rows(
      `SELECT DATE_FORMAT(locked_at, '%Y-%m-%d') AS locked_at, locked_by,
              DATE_FORMAT(removed_at, '%Y-%m-%d') AS removed_at, removed_by,
              removal_reason
       FROM posts WHERE id = 'p3'`,
    );
    expect(post).toEqual({
      locked_at: '2026-03-01',
      locked_by: null,
      removed_at: '2026-03-02',
      removed_by: null,
      removal_reason: 'Spam',
    });
    const [comment] = await rows(
      `SELECT locked_at IS NOT NULL AS locked, locked_by,
              removed_at IS NOT NULL AS removed, removed_by
       FROM comments WHERE id = 'm1'`,
    );
    expect(comment).toEqual({
      locked: 1,
      locked_by: null,
      removed: 1,
      removed_by: null,
    });
  });

  it.each([
    ['posts', 'idx_posts_removed_at'],
    ['comments', 'idx_comments_removed_at'],
  ])('filters %s on removed_at through the new index', async (table, index) => {
    await connection.query(`ANALYZE TABLE ${table}`);
    for (const predicate of ['removed_at IS NULL', 'removed_at IS NOT NULL']) {
      const [plan] = await rows(
        `EXPLAIN SELECT id FROM ${table} WHERE ${predicate}`,
      );
      expect({ predicate, key: plan.key as string }).toEqual({
        predicate,
        key: index,
      });
    }
  });
});
