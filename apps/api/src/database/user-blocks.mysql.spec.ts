import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
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
import { CommentsService } from '../comments/comments.service';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationInboxService } from '../notifications/notification-inbox.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { AccountDeletionService } from '../users/account-deletion.service';
import {
  BLOCKED_USERS_SQL,
  UserBlocksService,
} from '../users/user-blocks.service';
import { UsersService } from '../users/users.service';
import { VotesService } from '../votes/votes.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '028_create_user_blocks';

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 028 undone: the user_blocks block and its version.
const preceding = snapshot
  .replace(
    /-- One user's private block of another \(028_create_user_blocks\)\.\r?\nCREATE TABLE user_blocks \([\s\S]*?\r?\n\);\r?\n\r?\n/,
    '',
  )
  .replace(/,\r?\n\s*\('028_create_user_blocks'\)/, '');

// User blocks against a real MySQL server: migration 028 through the real
// runner, the check constraint, the cap under real concurrency, mutual blocks
// without a deadlock, the plans, account deletion, and the proof that a block
// changes nothing else yet. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_*
// credentials that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('user blocks (MySQL)', () => {
  const database = `user_blocks_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let blocks: UserBlocksService;
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
       WHERE table_schema = ? AND table_name = 'user_blocks'
       ORDER BY column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'user_blocks'
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
       WHERE k.table_schema = ? AND k.table_name = 'user_blocks'
       ORDER BY k.column_name`,
      [name],
    ),
    checks: await rows(
      `SELECT c.constraint_name AS name
       FROM information_schema.table_constraints c
       WHERE c.table_schema = ? AND c.table_name = 'user_blocks'
         AND c.constraint_type = 'CHECK'`,
      [name],
    ),
  });

  const blockRows = (blockerId: string) =>
    rows(
      'SELECT blocked_id, created_at FROM user_blocks WHERE blocker_id = ? ORDER BY blocked_id',
      [blockerId],
    );

  const withCap = (max: number) => {
    process.env.USER_BLOCKS_MAX = String(max);
    const capped = new UserBlocksService(pool);
    delete process.env.USER_BLOCKS_MAX;
    return capped;
  };

  beforeAll(async () => {
    expect(preceding).not.toContain('user_blocks');
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

    // heavy blocks 1,500 accounts so the plans are decided on a real range,
    // and is itself blocked by the first 300, for the reverse direction.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1500)
        SELECT CONCAT('u', n), CONCAT('user_', n), CONCAT('u', n, '@example.test'), 'x' FROM seq;
      INSERT INTO users (id, username, email, password_hash, display_name) VALUES
        ('heavy', 'heavy', 'heavy@example.test', 'x', NULL),
        ('alice', 'alice', 'alice@example.test', 'x', 'Alice'),
        ('bob', 'bob', 'bob@example.test', 'x', 'Bob'),
        ('carol', 'carol', 'carol@example.test', 'x', NULL),
        ('capper', 'capper', 'capper@example.test', 'x', NULL),
        ('leaver', 'leaver', 'leaver@example.test', 'x', 'Leaver');
      INSERT INTO user_blocks (blocker_id, blocked_id, created_at)
        SELECT 'heavy', id,
               TIMESTAMP('2026-11-01 00:00:00') + INTERVAL FLOOR(CAST(SUBSTRING(id, 2) AS UNSIGNED) / 2) SECOND
        FROM users WHERE id REGEXP '^u[0-9]+$';
      INSERT INTO user_blocks (blocker_id, blocked_id)
        SELECT id, 'heavy' FROM users
        WHERE id REGEXP '^u[0-9]+$' AND CAST(SUBSTRING(id, 2) AS UNSIGNED) <= 300;
      ANALYZE TABLE user_blocks, users;`);

    pool = createPool({ ...credentials, database, connectionLimit: 8 });
    blocks = new UserBlocksService(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  // Each test owns these accounts' blocks.
  afterEach(async () => {
    await connection.query(
      "DELETE FROM user_blocks WHERE blocker_id IN ('alice', 'bob', 'carol', 'capper')",
    );
  });

  describe('migration 028', () => {
    it('applies once, then skips', () => {
      expect(firstRun).toEqual([`Applied ${VERSION}`]);
      expect(secondRun).toEqual([]);
    });

    it('matches the snapshot exactly', async () => {
      expect(await schema(database)).toEqual(await schema(fresh));
    });

    it('creates the key, both indexes, the check and two cascading keys', async () => {
      const { indexes, foreignKeys, checks } = await schema(database);
      expect(indexes).toEqual(
        expect.arrayContaining([
          { name: 'PRIMARY', columns: 'blocker_id,blocked_id' },
          {
            name: 'idx_user_blocks_blocker_created',
            columns: 'blocker_id,created_at,blocked_id',
          },
          {
            name: 'idx_user_blocks_blocked',
            columns: 'blocked_id,blocker_id',
          },
        ]),
      );
      expect(foreignKeys).toEqual([
        { name: 'blocked_id', refers: 'users', on_delete: 'CASCADE' },
        { name: 'blocker_id', refers: 'users', on_delete: 'CASCADE' },
      ]);
      expect(checks).toEqual([{ name: 'chk_user_blocks_not_self' }]);
    });
  });

  describe('the check constraint', () => {
    it('refuses a self-block row on insert and on update', async () => {
      await expect(
        connection.query(
          "INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('alice', 'alice')",
        ),
      ).rejects.toMatchObject({
        errno: 3819,
        message: expect.stringContaining('chk_user_blocks_not_self') as unknown,
      });

      await connection.query(
        "INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('alice', 'bob')",
      );
      await expect(
        connection.query(
          "UPDATE user_blocks SET blocked_id = 'alice' WHERE blocker_id = 'alice' AND blocked_id = 'bob'",
        ),
      ).rejects.toMatchObject({ errno: 3819 });
    });
  });

  describe('blocking and unblocking', () => {
    it('is an idempotent upsert that keeps created_at, then an idempotent delete', async () => {
      await blocks.block('bob', 'alice');
      const first = await blockRows('alice');
      expect(first).toHaveLength(1);
      await connection.query('DO SLEEP(1.1)');
      await blocks.block('bob', 'alice');
      expect(await blockRows('alice')).toEqual(first);

      await blocks.unblock('bob', 'alice');
      await blocks.unblock('bob', 'alice');
      expect(await blockRows('alice')).toEqual([]);
    });

    it('answers 400 for yourself and 404 for an unknown user, writing nothing', async () => {
      await expect(blocks.block('alice', 'alice')).rejects.toMatchObject({
        status: 400,
      });
      await expect(blocks.block('nobody', 'alice')).rejects.toMatchObject({
        status: 404,
      });
      await expect(blocks.unblock('nobody', 'alice')).rejects.toMatchObject({
        status: 404,
      });
      expect(await blockRows('alice')).toEqual([]);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of many concurrent blocks take the last slot', async () => {
      const capped = withCap(3);
      await capped.block('user_1', 'capper');
      await capped.block('user_2', 'capper');

      const results = await Promise.allSettled(
        ['user_3', 'user_4', 'user_5', 'user_6', 'user_7'].map((username) =>
          capped.block(username, 'capper'),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.filter((r) => r.status === 'rejected');
      expect(refused).toHaveLength(4);
      for (const result of refused) {
        expect(result.reason).toMatchObject({ status: 409 });
      }
      expect(await blockRows('capper')).toHaveLength(3);
    });

    it('still accepts a repeat block at the cap, which adds no row', async () => {
      const capped = withCap(1);
      await capped.block('user_1', 'capper');
      await expect(capped.block('user_1', 'capper')).resolves.toBeUndefined();
      await expect(capped.block('user_2', 'capper')).rejects.toMatchObject({
        status: 409,
      });
      expect(await blockRows('capper')).toHaveLength(1);
    });

    // Each insert's foreign-key checks share-lock both users rows. Locking in
    // id order is what stops these two from deadlocking.
    it('does not deadlock when two users block each other at once', async () => {
      for (let round = 0; round < 30; round += 1) {
        await Promise.all([
          blocks.block('bob', 'alice'),
          blocks.block('alice', 'bob'),
        ]);
        expect(await blockRows('alice')).toHaveLength(1);
        expect(await blockRows('bob')).toHaveLength(1);
        await Promise.all([
          blocks.unblock('bob', 'alice'),
          blocks.unblock('alice', 'bob'),
        ]);
      }
    }, 60_000);
  });

  describe('the listing', () => {
    it('lists newest first with the blocked_id tiebreaker, and pages through everything', async () => {
      const first = await blocks.list('heavy', { limit: 100 });
      expect(first.total).toBe(1500);
      const expected = await rows(
        `SELECT u.username FROM user_blocks b JOIN users u ON u.id = b.blocked_id
         WHERE b.blocker_id = 'heavy'
         ORDER BY b.created_at DESC, b.blocked_id DESC LIMIT 100`,
      );
      expect(first.items.map((item) => item.username)).toEqual(
        expected.map((row) => String(row.username)),
      );

      const seen: string[] = [];
      for (let page = 1; page <= 15; page += 1) {
        const result = await blocks.list('heavy', { page, limit: 100 });
        seen.push(...result.items.map((item) => item.username));
      }
      expect(new Set(seen).size).toBe(1500);
    });

    it('returns the same identifier the write routes accept', async () => {
      await blocks.block('bob', 'alice');
      const { items } = await blocks.list('alice', {});
      expect(items).toEqual([
        {
          username: 'bob',
          display_name: 'Bob',
          blocked_at: expect.any(String) as unknown,
        },
      ]);
      await blocks.unblock(items[0].username, 'alice');
      expect(await blockRows('alice')).toEqual([]);
    });

    it('never returns another account’s blocks', async () => {
      await blocks.block('bob', 'alice');
      await blocks.block('carol', 'bob');
      const of = async (id: string) =>
        (await blocks.list(id, {})).items.map((item) => item.username);
      expect(await of('alice')).toEqual(['bob']);
      expect(await of('bob')).toEqual(['carol']);
      expect(await of('carol')).toEqual([]);
    });

    it('omits a deleted account even if a row survived, and counts the same way', async () => {
      await blocks.block('leaver', 'carol');
      await connection.query(
        "UPDATE users SET deleted_at = UTC_TIMESTAMP() WHERE id = 'leaver'",
      );
      await expect(blocks.list('carol', {})).resolves.toMatchObject({
        items: [],
        total: 0,
      });
      await expect(blocks.block('leaver', 'alice')).rejects.toMatchObject({
        status: 404,
      });
      await connection.query(
        "UPDATE users SET deleted_at = NULL WHERE id = 'leaver'",
      );
    });

    // Measured on MySQL 8.0: a ref on idx_user_blocks_blocker_created read
    // backwards in index order, each user by primary key.
    it('plans the listing on idx_user_blocks_blocker_created without a filesort', async () => {
      const plan = await rows(`EXPLAIN ${BLOCKED_USERS_SQL}`, [
        'heavy',
        20,
        40,
      ]);
      expect(plan.find((row) => row.table === 'b')).toMatchObject({
        key: 'idx_user_blocks_blocker_created',
      });
      expect(plan.find((row) => row.table === 'u')).toMatchObject({
        key: 'PRIMARY',
      });
      for (const row of plan) {
        expect(String(row.Extra)).not.toContain('Using filesort');
      }
    });

    // It exists for the enforcement work, so prove it serves that lookup now.
    it('serves the reverse direction from idx_user_blocks_blocked', async () => {
      const [plan] = await rows(
        "EXPLAIN SELECT blocker_id FROM user_blocks WHERE blocked_id = 'heavy'",
      );
      expect(plan).toMatchObject({ key: 'idx_user_blocks_blocked' });
      expect(String(plan.Extra)).toContain('Using index');
      expect(
        await rows(
          "SELECT blocker_id FROM user_blocks WHERE blocked_id = 'heavy'",
        ),
      ).toHaveLength(300);
    });
  });

  describe('deleting an account', () => {
    it('cascades both directions when the users row is hard-deleted', async () => {
      await connection.query(`
        INSERT INTO users (id, username, email, password_hash) VALUES
          ('gone-1', 'gone_1', 'gone1@example.test', 'x'),
          ('gone-2', 'gone_2', 'gone2@example.test', 'x');
        INSERT INTO user_blocks (blocker_id, blocked_id) VALUES
          ('gone-1', 'alice'), ('alice', 'gone-2');
        DELETE FROM users WHERE id IN ('gone-1', 'gone-2');`);
      expect(
        await rows(
          "SELECT 1 FROM user_blocks WHERE blocker_id LIKE 'gone-%' OR blocked_id LIKE 'gone-%'",
        ),
      ).toEqual([]);
    });

    // Account deletion anonymises the row, so the cascade never fires through
    // the API; the service deletes the blocks itself.
    it('removes the rows in both directions when deleted through the API', async () => {
      await connection.query(`
        INSERT INTO users (id, username, email, password_hash) VALUES
          ('self-del', 'self_del', 'self@example.test', 'x');
        INSERT INTO user_blocks (blocker_id, blocked_id) VALUES
          ('self-del', 'alice'), ('alice', 'self-del'), ('alice', 'carol');`);
      const deletion = new AccountDeletionService(pool, {
        passwordMatches: () => Promise.resolve(true),
        revokeAllSessions: () => Promise.resolve(),
      } as unknown as AuthService);

      await deletion.deleteOwnAccount('self-del', 'x');

      expect(
        await rows(
          "SELECT 1 FROM user_blocks WHERE blocker_id = 'self-del' OR blocked_id = 'self-del'",
        ),
      ).toEqual([]);
      // A block between two other accounts is untouched.
      expect(
        (await blockRows('alice')).map((row) => String(row.blocked_id)),
      ).toEqual(['carol']);
    });
  });

  // This issue is data and endpoints only. Both users do everything they could
  // before, with a block in place in each direction.
  describe('non-interference', () => {
    const accepting = {
      assertAcceptedOrThrow: () => Promise.resolve(),
    } as unknown as CommunityRuleAcceptanceService;
    const inboxQuery = { page: 1, limit: 20, sort: 'new' as const };

    it('leaves content reads, comments, votes and notifications unaffected', async () => {
      const notifications = new NotificationsService(pool);
      const comments = new CommentsService(pool, notifications, accepting);
      const votes = new VotesService(pool, accepting);
      const inbox = new NotificationInboxService(pool);
      const profiles = new UsersService(pool);
      const posts = new PostsService(
        pool,
        notifications,
        accepting,
        {} as CommunityModerationLogService,
      );

      await connection.query(`
        INSERT INTO communities (id, creator_id, name) VALUES ('c-ni', 'alice', 'noninterference');
        INSERT INTO posts (id, title, content, author_id, community_id) VALUES
          ('p-alice', 'First post', 'Body', 'alice', 'c-ni'),
          ('p-bob', 'Second post', 'Body', 'bob', 'c-ni');`);
      const profileBefore = await profiles.getUserProfile('alice');
      const postBefore = await posts.findOne('p-alice', 'bob');
      const inboxBefore = await inbox.list('alice', inboxQuery);

      await blocks.block('bob', 'alice');
      await blocks.block('alice', 'bob');

      // Reads are byte-identical for the blocked user.
      expect(await profiles.getUserProfile('alice')).toEqual(profileBefore);
      expect(await posts.findOne('p-alice', 'bob')).toEqual(postBefore);
      // Nothing was written to either inbox by the block itself.
      expect(await inbox.list('alice', inboxQuery)).toEqual(inboxBefore);
      expect((await inbox.list('bob', inboxQuery)).total).toBe(0);

      // Comment and reply across the block, in both directions.
      const comment = await comments.create(
        'p-alice',
        { content: 'A comment' },
        'bob',
      );
      const reply = await comments.create(
        'p-alice',
        { content: 'A reply', parent_id: comment.id },
        'alice',
      );
      expect(reply.parent_id).toBe(comment.id);

      // Votes across the block.
      await votes.vote(
        { target_type: 'post', target_id: 'p-alice', value: 1 },
        'bob',
      );
      await votes.vote(
        { target_type: 'post', target_id: 'p-bob', value: -1 },
        'alice',
      );
      expect((await posts.findOne('p-alice', 'bob')).score).toBe(1);
      expect((await posts.findOne('p-bob', 'alice')).score).toBe(-1);

      // Each still receives the other's notifications, and nothing mentions a
      // block.
      const received = async (id: string) => {
        const { items } = await inbox.list(id, inboxQuery);
        return items.map((item) => item.type);
      };
      expect(await received('alice')).toEqual(['post_comment']);
      expect(await received('bob')).toEqual(['comment_reply']);
      expect(
        JSON.stringify([
          await inbox.list('alice', inboxQuery),
          await inbox.list('bob', inboxQuery),
          await profiles.getUserProfile('alice'),
          await posts.findOne('p-alice', 'bob'),
        ]),
      ).not.toMatch(/block/i);
    });
  });
});
