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
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '018_add_content_listing_indexes';
const LISTING_INDEX = /^CREATE INDEX idx_\w+_(created|target) ON[^;]*;\r?\n/gm;

const INDEXES = {
  votes: { idx_votes_target: 'target_type,target_id,value' },
  posts: {
    idx_posts_community_created: 'community_id,created_at,id',
    idx_posts_author_created: 'author_id,created_at,id',
  },
  comments: {
    idx_comments_author_created: 'author_id,created_at,id',
    idx_comments_parent_created: 'parent_id,created_at,id',
    idx_comments_post_created: 'post_id,created_at,id',
  },
};
const TABLES = Object.keys(INDEXES) as (keyof typeof INDEXES)[];

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 018 undone: its six CREATE INDEX lines and its version.
const preceding = snapshot
  .replace(LISTING_INDEX, '')
  .replace(/,\r?\n\s*\('018_add_content_listing_indexes'\)/, '');

// The vote score aggregate, exactly as VotesService.vote issues it.
const SCORE_SQL =
  'SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE target_type = ? AND target_id = ?';

// Runs migration 018 through the real runner on a real MySQL server, over a
// seeded database at version 017, and checks that each listing query is
// planned on its new index. Opt in with MYSQL_INTEGRATION_TEST=true and
// MYSQL_* credentials that may create and drop scratch databases; skipped
// otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('content listing indexes (MySQL)', () => {
  const database = `listing_indexes_${randomBytes(4).toString('hex')}`;
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
  // Every statement the services send through the pool.
  const issued: { sql: string; values: unknown[] }[] = [];
  let responsesBefore: unknown;
  let indexesBefore: Record<string, RowDataPacket[]>;
  let foreignKeysBefore: Record<string, RowDataPacket[]>;

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

  // What the public read endpoints and the vote aggregate return.
  const responses = async () => ({
    list: await posts.findAll({ limit: 100 }),
    community: await posts.findAll({ community_id: 'c1', page: 2, limit: 20 }),
    thread: await comments.findThread('p2'),
    score: await rows(SCORE_SQL, ['post', 'p1']),
  });

  // Every index of a table and its columns in order.
  const indexes = (schema: string, table: string) =>
    rows(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = ?
       GROUP BY index_name ORDER BY index_name`,
      [schema, table],
    );

  // Every foreign key of a table, its column, target and delete rule.
  const foreignKeys = (schema: string, table: string) =>
    rows(
      `SELECT k.constraint_name AS name, k.column_name AS column_name,
              k.referenced_table_name AS referenced, r.delete_rule AS on_delete
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.table_schema
        AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = ? AND k.table_name = ?
       ORDER BY k.constraint_name`,
      [schema, table],
    );

  const plan = async (sql: string, values: unknown[]) => {
    const result = await rows(`EXPLAIN ${sql}`, values);
    expect(result).toHaveLength(1);
    return {
      key: result[0].key as string | null,
      type: result[0].type as string,
      extra: (result[0].Extra as string | null) ?? '',
    };
  };

  // The single ordered listing statement a service call issued.
  const listingIssuedBy = async (call: () => Promise<unknown>) => {
    issued.length = 0;
    await call();
    const listings = issued.filter(({ sql }) => sql.includes('ORDER BY'));
    expect(listings).toHaveLength(1);
    return listings[0];
  };

  beforeAll(async () => {
    expect(preceding).not.toMatch(LISTING_INDEX);
    expect(preceding).not.toContain(VERSION);

    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await connection.query(
      `CREATE DATABASE ${fresh}; USE ${fresh}; ${snapshot}`,
    );
    await connection.query(
      `CREATE DATABASE ${database}; USE ${database}; ${preceding}`,
    );

    // 50 authors, 20 communities, 4000 posts, 4000 comments (1000 roots,
    // 3000 replies to the first 100) and 5000 votes, so every filter matches
    // a few percent of its table and a scan is never the cheaper plan.
    // created_at repeats in pairs so the id tiebreaker decides real orders.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50)
        SELECT CONCAT('u', n), CONCAT('u', n), CONCAT('u', n, '@example.test'), 'x'
        FROM seq;
      INSERT INTO communities (id, creator_id, name)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20)
        SELECT CONCAT('c', n), 'u1', CONCAT('c', n) FROM seq;
      INSERT INTO posts (id, title, content, author_id, community_id, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 4000)
        SELECT CONCAT('p', n), CONCAT('Post ', n), 'Body',
               CONCAT('u', 1 + n % 50), CONCAT('c', 1 + n % 20),
               TIMESTAMP('2026-01-01 00:00:00') + INTERVAL FLOOR(n / 2) MINUTE
        FROM seq;
      INSERT INTO comments (id, post_id, author_id, parent_id, content, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1000)
        SELECT CONCAT('m', n), CONCAT('p', 1 + n % 400), CONCAT('u', 1 + n % 50),
               NULL, 'Root',
               TIMESTAMP('2026-02-01 00:00:00') + INTERVAL FLOOR(n / 2) MINUTE
        FROM seq;
      INSERT INTO comments (id, post_id, author_id, parent_id, content, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 3000)
        SELECT CONCAT('r', n), CONCAT('p', 2 + n % 100), CONCAT('u', 1 + n % 50),
               CONCAT('m', 1 + n % 100), 'Reply',
               TIMESTAMP('2026-03-01 00:00:00') + INTERVAL FLOOR(n / 2) MINUTE
        FROM seq;
      INSERT INTO votes (id, user_id, target_type, target_id, value)
        WITH RECURSIVE seq (n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 4999)
        SELECT CONCAT('v', n), CONCAT('u', 1 + n % 50),
               IF(n < 2500, 'post', 'comment'),
               IF(n < 2500, CONCAT('p', 1 + FLOOR(n / 50)),
                            CONCAT('m', 1 + FLOOR(n / 50))),
               IF(n % 3 = 0, -1, 1)
        FROM seq;`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    const recording = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === 'execute') {
          return (sql: string, values: (string | number)[] = []) => {
            issued.push({ sql, values });
            return target.execute(sql, values);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    // The read paths consult neither notifications nor rule acceptance.
    posts = new PostsService(
      recording,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
    );
    comments = new CommentsService(
      recording,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
    );
    responsesBefore = await responses();
    indexesBefore = {};
    foreignKeysBefore = {};
    for (const table of TABLES) {
      indexesBefore[table] = await indexes(database, table);
      foreignKeysBefore[table] = await foreignKeys(database, table);
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  it('applies 018 to a database at 017 once, and skips it on a second run', async () => {
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
    for (const table of TABLES) {
      await connection.query(`ANALYZE TABLE ${table}`);
    }
  }, 60_000);

  it('leaves the read responses and the vote score identical', async () => {
    const after = await responses();
    expect(JSON.stringify(after)).toBe(JSON.stringify(responsesBefore));
  });

  it.each(TABLES)(
    'adds exactly the new indexes to %s, in column order, as the snapshot does',
    async (table) => {
      const migrated = await indexes(database, table);
      const added = Object.entries(INDEXES[table]).map(([name, columns]) => ({
        name,
        columns,
      }));
      const byName = (a: RowDataPacket, b: RowDataPacket) =>
        String(a.name).localeCompare(String(b.name));

      expect([...migrated].sort(byName)).toEqual(
        [...indexesBefore[table], ...added].sort(byName),
      );
      await expect(indexes(fresh, table)).resolves.toEqual(migrated);
    },
  );

  it.each(TABLES)(
    'keeps every foreign key on %s, each led by an index',
    async (table) => {
      const migrated = await foreignKeys(database, table);
      expect(migrated.length).toBeGreaterThan(0);
      expect(migrated).toEqual(foreignKeysBefore[table]);
      await expect(foreignKeys(fresh, table)).resolves.toEqual(migrated);

      const leading = (await indexes(database, table)).map(
        (index) => String(index.columns).split(',')[0],
      );
      for (const key of migrated) {
        expect(leading).toContain(key.column_name);
      }
    },
  );

  it.each([
    ['posts', ['author_id', 'community_id']],
    ['comments', ['author_id', 'parent_id', 'post_id']],
  ])(
    'keeps the implicit single-column foreign-key indexes on %s',
    async (table, columns) => {
      for (const schema of [database, fresh]) {
        const single = (await indexes(schema, table)).map(
          (index) => index.columns as string,
        );
        for (const column of columns) {
          expect({ schema, column, present: single.includes(column) }).toEqual({
            schema,
            column,
            present: true,
          });
        }
      }
    },
  );

  it('computes a vote score from idx_votes_target alone', async () => {
    for (const target of [
      ['post', 'p1'],
      ['comment', 'm1'],
    ]) {
      const result = await plan(SCORE_SQL, target);
      expect(result.key).toBe('idx_votes_target');
      expect(result.type).not.toBe('ALL');
      expect(result.extra).toContain('Using index');
    }
  });

  it("lists a community's posts on idx_posts_community_created without a filesort", async () => {
    const { sql, values } = await listingIssuedBy(() =>
      posts.findAll({ community_id: 'c1', page: 2, limit: 20 }),
    );
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    const result = await plan(sql, values);
    expect(result.key).toBe('idx_posts_community_created');
    expect(result.extra).not.toContain('Using filesort');
  });

  it("reads a post's thread on idx_comments_post_created without a filesort", async () => {
    const { sql, values } = await listingIssuedBy(() =>
      comments.findThread('p2'),
    );
    expect(sql).toContain('ORDER BY created_at ASC, id ASC');
    const result = await plan(sql, values);
    expect(result.key).toBe('idx_comments_post_created');
    expect(result.extra).not.toContain('Using filesort');
  });

  it.each([
    [
      "one author's posts newest-first",
      'SELECT id, title, content, type, author_id, community_id, created_at FROM posts WHERE author_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      ['u7', 20, 20],
      'idx_posts_author_created',
    ],
    [
      "one author's comments newest-first",
      'SELECT id, post_id, author_id, parent_id, content, created_at FROM comments WHERE author_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      ['u7', 20, 20],
      'idx_comments_author_created',
    ],
    [
      "one comment's replies oldest-first",
      'SELECT id, post_id, author_id, parent_id, content, created_at FROM comments WHERE parent_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?',
      ['m1', 20, 0],
      'idx_comments_parent_created',
    ],
    [
      "one comment's replies newest-first",
      'SELECT id, post_id, author_id, parent_id, content, created_at FROM comments WHERE parent_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      ['m1', 20, 0],
      'idx_comments_parent_created',
    ],
  ])(
    'pages %s on its index without a filesort',
    async (_case, sql, values, index) => {
      const result = await plan(sql, values);
      expect(result.key).toBe(index);
      expect(result.extra).not.toContain('Using filesort');
    },
  );
});
