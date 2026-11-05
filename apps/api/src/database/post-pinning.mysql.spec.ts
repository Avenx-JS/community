import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
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
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { removeTriggerRules, runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '026_add_post_pinning';

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 026 undone: the chk_posts_pin trigger pair, every line
// naming pinned_at or pinned_by (columns and foreign key), the index, and the
// version.
const preceding = removeTriggerRules(snapshot, 'chk_posts_pin')
  .replace(/^.*\bpinned_(at|by)\b.*\r?\n/gm, '')
  .replace(/,(\s*\r?\n\);)/g, '$1')
  .replace(/,\r?\n\s*\('026_add_post_pinning'\)/, '');

// Runs migration 026 through the real runner on a real MySQL server, over a
// seeded database at version 025, then drives PostsService against it: the
// pin and unpin transactions, the cap under real concurrency, and the plan
// of the single-community listing that floats pins. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and
// drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('post pinning (MySQL)', () => {
  const database = `post_pinning_${randomBytes(4).toString('hex')}`;
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
  let firstRun: string[];
  let secondRun: string[];
  let listingBefore: unknown;
  // Every statement the service sends through the pool.
  const issued: { sql: string; values: unknown[] }[] = [];

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

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };

  const schema = async (name: string) => ({
    columns: await rows(
      `SELECT column_name AS name, column_type AS type,
              is_nullable AS nullable, column_default AS def
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'posts'
       ORDER BY column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'posts'
       GROUP BY index_name ORDER BY index_name`,
      [name],
    ),
    constraints: await rows(
      `SELECT constraint_name AS name, constraint_type AS type
       FROM information_schema.table_constraints
       WHERE table_schema = ? AND table_name = 'posts'
       ORDER BY constraint_name`,
      [name],
    ),
    // By name, not ACTION_ORDER: the rebuilt history creates 026's pair
    // before 017's, a fresh install after; independent checks ignore order.
    triggers: await rows(
      `SELECT trigger_name AS name, action_timing AS timing,
              event_manipulation AS event, action_statement AS statement
       FROM information_schema.triggers
       WHERE event_object_schema = ? AND event_object_table = 'posts'
       ORDER BY trigger_name`,
      [name],
    ),
  });

  const pinnedIds = async (community: string) =>
    (
      await rows(
        'SELECT id FROM posts WHERE community_id = ? AND pinned_at IS NOT NULL ORDER BY id',
        [community],
      )
    ).map((row) => row.id as string);

  const unpinAll = () =>
    connection.query(
      'UPDATE posts SET pinned_at = NULL, pinned_by = NULL WHERE pinned_at IS NOT NULL',
    );

  // The single ordered listing statement a service call issued.
  const listingIssuedBy = async (call: () => Promise<unknown>) => {
    issued.length = 0;
    await call();
    const listings = issued.filter(({ sql }) => sql.includes('ORDER BY'));
    expect(listings).toHaveLength(1);
    return listings[0];
  };

  beforeAll(async () => {
    expect(preceding).not.toMatch(/pinned_at|pinned_by|chk_posts_pin/);
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

    // 50 users, 20 communities created by u1 (u2 moderates c1, u3 moderates
    // c2), and 4000 posts, so c1 holds 200 posts and a single community's
    // listing is a real range rather than a handful of rows. created_at
    // repeats in pairs so the id tiebreaker decides real orders.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50)
        SELECT CONCAT('u', n), CONCAT('u', n), CONCAT('u', n, '@example.test'), 'x'
        FROM seq;
      INSERT INTO communities (id, creator_id, name)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20)
        SELECT CONCAT('c', n), 'u1', CONCAT('c', n) FROM seq;
      INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES
        ('c1', 'u2', 'u1'), ('c2', 'u3', 'u1');
      INSERT INTO posts (id, title, content, author_id, community_id, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 4000)
        SELECT CONCAT('p', n), CONCAT('Post ', n), 'Body',
               CONCAT('u', 1 + n % 50), CONCAT('c', 1 + n % 20),
               TIMESTAMP('2026-01-01 00:00:00') + INTERVAL FLOOR(n / 2) MINUTE
        FROM seq;`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
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
    // The read path, captured before 026, cannot select the new columns, so
    // the "unchanged feed" baseline is taken with SQL of the old shape.
    listingBefore = await rows(
      'SELECT id FROM posts ORDER BY created_at DESC, id DESC LIMIT 100',
    );

    firstRun = await migrate();
    secondRun = await migrate();
    await connection.query('ANALYZE TABLE posts');

    process.env.COMMUNITY_PINNED_POSTS_MAX = '3';
    // Pinning consults neither notifications nor rule acceptance.
    posts = new PostsService(
      recording,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
      new CommunityModerationLogService(pool),
    );
    delete process.env.COMMUNITY_PINNED_POSTS_MAX;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  it('applies 026 once, then skips it', () => {
    expect(firstRun).toEqual([`Applied ${VERSION}`]);
    expect(secondRun).toEqual([]);
  });

  it('matches the snapshot exactly', async () => {
    expect(await schema(database)).toEqual(await schema(fresh));
  });

  it('adds both columns, the foreign key, the check and the index', async () => {
    const { columns, indexes, constraints, triggers } = await schema(database);
    expect(
      columns.filter((column) => /^pinned_/.test(String(column.name))),
    ).toEqual([
      { name: 'pinned_at', type: 'timestamp', nullable: 'YES', def: null },
      { name: 'pinned_by', type: 'varchar(36)', nullable: 'YES', def: null },
    ]);
    expect(indexes).toContainEqual({
      name: 'idx_posts_community_pinned',
      columns: 'community_id,pinned_at',
    });
    expect(constraints).toContainEqual({
      name: 'fk_posts_pinned_by',
      type: 'FOREIGN KEY',
    });
    // MySQL 8 refuses a CHECK on pinned_by (its foreign key is ON DELETE SET
    // NULL), so chk_posts_pin is a BEFORE INSERT and BEFORE UPDATE trigger.
    expect(constraints.map((c) => String(c.name))).not.toContain(
      'chk_posts_pin',
    );
    expect(
      triggers
        .filter((t) => String(t.name).startsWith('trg_posts_pin_'))
        .map((t) => ({
          name: String(t.name),
          timing: String(t.timing),
          event: String(t.event),
        })),
    ).toEqual([
      { name: 'trg_posts_pin_insert', timing: 'BEFORE', event: 'INSERT' },
      { name: 'trg_posts_pin_update', timing: 'BEFORE', event: 'UPDATE' },
    ]);
    const [rule] = await rows(
      `SELECT delete_rule FROM information_schema.referential_constraints
       WHERE constraint_schema = ? AND constraint_name = 'fk_posts_pinned_by'`,
      [database],
    );
    expect(rule.delete_rule ?? rule.DELETE_RULE).toBe('SET NULL');
  });

  it('leaves every existing post unpinned and the global feed unchanged', async () => {
    expect(
      await rows(
        'SELECT id FROM posts WHERE pinned_at IS NOT NULL OR pinned_by IS NOT NULL',
      ),
    ).toEqual([]);
    const after = await posts.findAll({ limit: 100 });
    expect(after.items.map((post) => post.id)).toEqual(
      (listingBefore as RowDataPacket[]).map((row) => row.id as string),
    );
  });

  it('rejects pinned_by without pinned_at, and clearing pinned_at alone', async () => {
    await expect(
      connection.query("UPDATE posts SET pinned_by = 'u2' WHERE id = 'p20'"),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });

    await connection.query(
      "UPDATE posts SET pinned_at = UTC_TIMESTAMP(), pinned_by = 'u2' WHERE id = 'p20'",
    );
    await expect(
      connection.query("UPDATE posts SET pinned_at = NULL WHERE id = 'p20'"),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    // A timestamp alone is a valid pin (an actor whose account is gone).
    await connection.query(
      "UPDATE posts SET pinned_by = NULL WHERE id = 'p20'",
    );
    await unpinAll();
  });

  it('pins from the database clock and logs the entry in the same transaction', async () => {
    const pinned = await posts.pin('p20', 'u2');

    expect(pinned).toMatchObject({ id: 'p20', pinned_by: 'u2' });
    // pinned_at is whatever the server wrote, read back through the driver.
    const [stored] = await pool.query<RowDataPacket[]>(
      "SELECT pinned_at FROM posts WHERE id = 'p20'",
    );
    expect(pinned.pinned_at).toBe((stored[0].pinned_at as Date).toISOString());
    expect(
      await rows(
        "SELECT community_id, actor_id, actor_username, action, target_type FROM community_moderation_actions WHERE target_id = 'p20'",
      ),
    ).toEqual([
      {
        community_id: 'c1',
        actor_id: 'u2',
        actor_username: 'u2',
        action: 'post_pinned',
        target_type: 'post',
      },
    ]);

    // Idempotent: the creator's repeat neither refreshes nor logs.
    await expect(posts.pin('p20', 'u1')).resolves.toEqual(pinned);
    const [count] = await rows(
      "SELECT COUNT(*) AS n FROM community_moderation_actions WHERE target_id = 'p20'",
    );
    expect(Number(count.n)).toBe(1);

    await posts.unpin('p20', 'u1');
    expect(await pinnedIds('c1')).toEqual([]);
    expect(
      (
        await rows(
          "SELECT action FROM community_moderation_actions WHERE target_id = 'p20' ORDER BY action",
        )
      ).map((row) => row.action as string),
    ).toEqual(['post_pinned', 'post_unpinned']);
  });

  it('refuses a moderator of another community and the post author', async () => {
    // p21 is in c2 (1 + 21 % 20), authored by u22, moderated by u3 only.
    await expect(posts.pin('p20', 'u3')).rejects.toMatchObject({
      status: 403,
    });
    await expect(posts.pin('p21', 'u22')).rejects.toMatchObject({
      status: 403,
    });
    await expect(posts.pin('p21', 'u3')).resolves.toMatchObject({
      pinned_by: 'u3',
    });
    await unpinAll();
  });

  it('lets exactly one of two concurrent pins at the cap boundary succeed', async () => {
    await unpinAll();
    await posts.pin('p40', 'u2');
    await posts.pin('p60', 'u2');

    // The cap is 3: two transactions race for the last slot.
    const outcomes = await Promise.allSettled([
      posts.pin('p80', 'u1'),
      posts.pin('p100', 'u2'),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toEqual(
      new ConflictException('A community can have at most 3 pinned posts'),
    );
    expect(await pinnedIds('c1')).toHaveLength(3);
  }, 30_000);

  it('lists pins first in a single community, with stable pages across the pinned set', async () => {
    await unpinAll();
    // Pinned oldest post first, so the most recently pinned (p60) leads.
    for (const id of ['p20', 'p40', 'p60']) {
      await posts.pin(id, 'u2');
      // pinned_at has one-second resolution; space the pins apart.
      await connection.query(
        'UPDATE posts SET pinned_at = pinned_at - INTERVAL ? SECOND WHERE id = ?',
        [{ p20: 30, p40: 20, p60: 10 }[id], id],
      );
    }

    const all = await posts.findAll({ community_id: 'c1', limit: 100 });
    const ids = all.items.map((post) => post.id);
    expect(ids.slice(0, 3)).toEqual(['p60', 'p40', 'p20']);
    const unpinned = await rows(
      "SELECT id FROM posts WHERE community_id = 'c1' AND pinned_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 97",
    );
    expect(ids.slice(3)).toEqual(unpinned.map((row) => row.id as string));
    expect(all.total).toBe(200);

    // limit 2 puts a page boundary inside the pinned set.
    const paged: string[] = [];
    for (const page of [1, 2, 3, 4]) {
      const result = await posts.findAll({
        community_id: 'c1',
        limit: 2,
        page,
      });
      paged.push(...result.items.map((post) => post.id));
    }
    expect(paged).toEqual(ids.slice(0, 8));

    // The unfiltered feed does not float them.
    const feed = await posts.findAll({ limit: 100 });
    expect(feed.items.map((post) => post.id)).toEqual(
      (listingBefore as RowDataPacket[]).map((row) => row.id as string),
    );
  });

  it("records the single-community listing's plan: a filesort over the community's rows", async () => {
    const { sql, values } = await listingIssuedBy(() =>
      posts.findAll({ community_id: 'c1', page: 2, limit: 20 }),
    );
    expect(sql).toContain(
      'ORDER BY (pinned_at IS NULL), pinned_at DESC, created_at DESC, id DESC',
    );
    const explained = await rows(`EXPLAIN ${sql}`, values);
    const plan = explained.filter((row) => row.table === 'posts');
    expect(plan).toHaveLength(1);
    // The community filter is an index lookup on a community_id-led index,
    // never a scan of every post; the order cannot come from that index.
    expect(plan[0].type).toBe('ref');
    expect(String(plan[0].key)).toMatch(
      /^(community_id|idx_posts_community_(created|pinned))$/,
    );
    // The deleted-community EXISTS becomes a semi-join led by the const
    // communities row, so MySQL reports the filesort on that first row
    // rather than on posts (measured on MySQL 8.0.46).
    expect(
      explained.some((row) => String(row.Extra).includes('Using filesort')),
    ).toBe(true);
  });

  it('keeps a pin when the pinning moderator is deleted, rendering pinned_by null', async () => {
    await unpinAll();
    await connection.query(
      "INSERT INTO users (id, username, email, password_hash) VALUES ('gone', 'gone', 'gone@example.test', 'x')",
    );
    await connection.query(
      "INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES ('c1', 'gone', 'u1')",
    );
    const pinned = await posts.pin('p20', 'gone');

    await connection.query("DELETE FROM users WHERE id = 'gone'");

    const after = await posts.findOne('p20');
    expect(after.pinned_at).toBe(pinned.pinned_at);
    expect(after.pinned_by).toBeNull();
  });
});
