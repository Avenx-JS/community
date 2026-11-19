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
import { NotificationsService } from '../notifications/notifications.service';
import { AccountDeletionService } from '../users/account-deletion.service';
import { UserBlockPolicyService } from '../users/user-block-policy.service';
import { UserBlocksService } from '../users/user-blocks.service';
import { UserFollowsService } from '../users/user-follows.service';
import { UsersService } from '../users/users.service';
import { snapshotBefore } from './enum-history';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '047_create_user_follows';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 047 and every later folded migration undone
// (enum-history.ts); the runner then applies them in order.
const preceding = snapshotBefore(snapshot, '047');

// Migration 047 through the real runner, then following with the real
// services on a real server: the lists, the counts, blocks and account
// deletion. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials
// that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('user follows (MySQL)', () => {
  const database = `user_follows_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let follows: UserFollowsService;
  let blocks: UserBlocksService;
  let users: UsersService;
  let deletion: AccountDeletionService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const schema = (name: string) =>
    rows(
      `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS n, column_default AS d
       FROM information_schema.columns
       WHERE table_schema = ? AND (table_name = 'user_follows'
         OR (table_name = 'notifications' AND column_name IN ('type', 'subject_type'))
         OR (table_name = 'user_preferences' AND column_name = 'notify_new_followers'))
       ORDER BY 1, 2`,
      [name],
    );
  const indexes = (name: string) =>
    rows(
      `SELECT index_name AS i, seq_in_index AS s, column_name AS c
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'user_follows'
       ORDER BY 1, 2`,
      [name],
    );
  const pairs = async () =>
    (
      await rows(
        'SELECT follower_id, followee_id FROM user_follows ORDER BY 1, 2',
      )
    ).map((row) => `${row.follower_id}->${row.followee_id}`);
  const names = (list: { items: Array<{ username: string }> }) =>
    list.items.map(({ username }) => username);

  beforeAll(async () => {
    expect(preceding).not.toMatch(/user_follows|notify_new_followers/);
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
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('a', 'alice', 'alice@example.test', 'x'),
        ('b', 'bob', 'bob@example.test', 'x'),
        ('c', 'carol', 'carol@example.test', 'x'),
        ('d', 'dave', 'dave@example.test', 'x'),
        ('e', 'erin', 'erin@example.test', 'x');
      -- erin does not want to hear of new followers.
      INSERT INTO user_preferences (user_id, notify_new_followers) VALUES ('e', FALSE);`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    follows = new UserFollowsService(
      pool,
      new UserBlockPolicyService(pool),
      new NotificationsService(pool),
    );
    blocks = new UserBlocksService(pool);
    users = new UsersService(pool);
    deletion = new AccountDeletionService(pool, {
      passwordMatches: () => Promise.resolve(true),
      revokeAllSessions: () => Promise.resolve(),
      announceSessionsChanged: () => undefined,
    } as unknown as AuthService);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  it('applies 047, matching a fresh installation', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await schema(database)).toEqual(await schema(fresh));
    expect(await indexes(database)).toEqual(await indexes(fresh));
  });

  it('refuses a self-follow in the database too', async () => {
    await expect(
      connection.query(
        "INSERT INTO user_follows (follower_id, followee_id) VALUES ('a', 'a')",
      ),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  });

  it('follows idempotently, notifying once and honouring the preference', async () => {
    await follows.follow('carol', 'a');
    await follows.follow('carol', 'a');
    await follows.follow('carol', 'b');
    await follows.follow('alice', 'b');
    await follows.follow('erin', 'a');
    expect(await pairs()).toEqual(['a->c', 'a->e', 'b->a', 'b->c']);
    // Unfollowing and following again does not notify a second time.
    await follows.unfollow('carol', 'a');
    await follows.follow('carol', 'a');
    expect(
      await rows(
        `SELECT recipient_id, actor_id, subject_type, subject_id, metadata
         FROM notifications WHERE type = 'new_follower' ORDER BY recipient_id, actor_id`,
      ),
    ).toEqual([
      {
        recipient_id: 'a',
        actor_id: 'b',
        subject_type: 'user',
        subject_id: 'b',
        metadata: { actor_username: 'bob' },
      },
      {
        recipient_id: 'c',
        actor_id: 'a',
        subject_type: 'user',
        subject_id: 'a',
        metadata: { actor_username: 'alice' },
      },
      {
        recipient_id: 'c',
        actor_id: 'b',
        subject_type: 'user',
        subject_id: 'b',
        metadata: { actor_username: 'bob' },
      },
    ]);
  });

  it('lists, pages, counts and reports the status', async () => {
    const followers = await follows.list('followers', 'carol', undefined, {});
    // a followed carol again after b: newest first.
    expect(names(followers)).toEqual(['alice', 'bob']);
    expect(followers.total).toBe(2);
    const page = await follows.list('followers', 'carol', undefined, {
      page: 2,
      limit: 1,
    });
    expect(names(page)).toEqual(['bob']);
    expect(page.total).toBe(2);
    expect(
      names(await follows.list('following', 'alice', undefined, {})).sort(),
    ).toEqual(['carol', 'erin']);
    await expect(users.getUserProfile('carol')).resolves.toMatchObject({
      follower_count: 2,
      following_count: 0,
    });
    await expect(users.getOwnProfile('a')).resolves.toMatchObject({
      follower_count: 1,
      following_count: 2,
    });
    await expect(follows.status('alice', 'b')).resolves.toEqual({
      following: true,
      followed_by: false,
    });
  });

  it('leaves accounts blocked either way out of a viewer’s lists', async () => {
    await connection.query(
      "INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('d', 'b')",
    );
    expect(names(await follows.list('followers', 'carol', 'd', {}))).toEqual([
      'alice',
    ]);
    expect((await follows.list('followers', 'carol', 'd', {})).total).toBe(1);
    expect(names(await follows.list('followers', 'carol', 'b', {}))).toEqual([
      'alice',
      'bob',
    ]);
    await connection.query("DELETE FROM user_blocks WHERE blocker_id = 'd'");
  });

  it('refuses a follow across a block, and a block removes the pair’s follows both ways', async () => {
    await follows.follow('bob', 'c');
    await follows.follow('carol', 'd');
    expect(await pairs()).toContain('c->b');
    await blocks.block('carol', 'b');
    // b->c and c->b are gone; d->c stays.
    expect(await pairs()).toEqual(['a->c', 'a->e', 'b->a', 'd->c']);
    await expect(follows.follow('bob', 'c')).rejects.toMatchObject({
      status: 403,
    });
    await expect(follows.follow('carol', 'b')).rejects.toMatchObject({
      status: 403,
    });
    await blocks.unblock('carol', 'b');
    // Unblocking does not restore them.
    expect(await pairs()).toEqual(['a->c', 'a->e', 'b->a', 'd->c']);
  });

  it('removes a deleted account from both sides, lists and counts', async () => {
    await deletion.deleteOwnAccount('a', 'password');
    expect(await pairs()).toEqual(['d->c']);
    await expect(users.getUserProfile('carol')).resolves.toMatchObject({
      follower_count: 1,
    });
    await expect(
      follows.list('followers', 'carol', undefined, {}),
    ).resolves.toMatchObject({ items: [{ username: 'dave' }], total: 1 });
    await expect(follows.follow('alice', 'd')).rejects.toMatchObject({
      status: 404,
    });
  });
});
