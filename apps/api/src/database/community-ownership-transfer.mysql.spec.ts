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
import { CommunitiesService } from '../communities/communities.service';
import { CommunityBanPolicyService } from '../communities/community-ban-policy.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AccountDeletionService,
  COMMUNITY_CREATOR_MESSAGE,
} from '../users/account-deletion.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '042_add_community_ownership_transfer';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 042 undone: its header, its version and the two enum
// members it folded into CREATE TABLE.
const preceding = snapshot
  .replace(
    /-- Community ownership transfer \(042_add_community_ownership_transfer\)\.\r?\n(?:--[^\n]*\r?\n)*\r?\n/,
    '',
  )
  .replace(/,\r?\n\s*\('042_add_community_ownership_transfer'\)/, '')
  .replace(/,\r?\n\s*'ownership_transferred'/, '')
  .replace(/,\r?\n\s*'community_ownership_transferred'/, '');

// Migration 042 through the real runner over a database at 041, then
// transfers and account deletion on a real server. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and
// drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community ownership transfer (MySQL)', () => {
  const database = `ownership_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let communities: CommunitiesService;
  let deletion: AccountDeletionService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const transfer = (username: string, actor = 'founder', confirm = 'garden') =>
    communities.transferOwnership(
      'garden',
      { username, confirm_name: confirm },
      actor,
    );
  const enums = async (name: string) =>
    rows(
      `SELECT table_name AS t, column_type AS type FROM information_schema.columns
       WHERE table_schema = ? AND ((table_name = 'community_moderation_actions' AND column_name = 'action')
         OR (table_name = 'notifications' AND column_name = 'type'))
       ORDER BY table_name`,
      [name],
    );

  beforeAll(async () => {
    expect(preceding).not.toMatch(/ownership_transferred/);
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
        ('founder', 'founder', 'founder@example.test', 'x'),
        ('heir', 'heir', 'heir@example.test', 'x'),
        ('member', 'member', 'member@example.test', 'x'),
        ('banned', 'banned', 'banned@example.test', 'x'),
        ('suspended', 'suspended', 'suspended@example.test', 'x');
      INSERT INTO users (id, username, email, password_hash, deleted_at)
        VALUES ('gone', 'gone', 'gone@example.test', 'x', UTC_TIMESTAMP());
      INSERT INTO communities (id, creator_id, name) VALUES ('k-1', 'founder', 'garden');
      INSERT INTO community_subscriptions (user_id, community_id) VALUES
        ('heir', 'k-1'), ('member', 'k-1'), ('banned', 'k-1'), ('suspended', 'k-1');
      INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES
        ('k-1', 'heir', 'founder'), ('k-1', 'banned', 'founder'),
        ('k-1', 'suspended', 'founder'), ('k-1', 'gone', 'founder');
      INSERT INTO community_bans (id, community_id, user_id, reason)
        VALUES ('b-1', 'k-1', 'banned', 'Spam');
      INSERT INTO user_restrictions (id, user_id, type, reason, expires_at)
        VALUES ('r-1', 'suspended', 'suspension', 'Spam', UTC_TIMESTAMP() + INTERVAL 1 DAY);`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    communities = new CommunitiesService(
      pool,
      {} as CommunityRuleAcceptanceService,
      new CommunityModerationLogService(pool),
      new CommunityBanPolicyService(pool),
      new NotificationsService(pool),
    );
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

  it('applies 042, matching a fresh installation', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await enums(database)).toEqual(await enums(fresh));
  });

  it.each([
    [
      'a mismatched confirmation',
      () => transfer('heir', 'founder', 'Garden'),
      400,
    ],
    ['a caller who is not the creator', () => transfer('member', 'heir'), 403],
    ['an unknown user', () => transfer('nobody'), 404],
    ['a deleted user', () => transfer('gone'), 404],
    ['the creator themselves', () => transfer('founder'), 400],
    ['a platform-suspended moderator', () => transfer('suspended'), 409],
    ['a moderator banned from the community', () => transfer('banned'), 409],
    ['a member who is not a moderator', () => transfer('member'), 409],
  ])('refuses %s, changing nothing', async (_, act, status) => {
    await expect(act()).rejects.toMatchObject({ status });
    expect(
      await rows("SELECT creator_id FROM communities WHERE id = 'k-1'"),
    ).toEqual([{ creator_id: 'founder' }]);
    expect(
      await rows(
        "SELECT id FROM community_moderation_actions WHERE action = 'ownership_transferred'",
      ),
    ).toEqual([]);
  });

  it('refuses to delete the founder while they own the community', async () => {
    await expect(
      deletion.deleteOwnAccount('founder', 'password'),
    ).rejects.toThrow(COMMUNITY_CREATOR_MESSAGE);
  });

  it('transfers to a moderator, keeping the former owner as one, logged and notified', async () => {
    await transfer('heir');

    expect(
      await rows("SELECT creator_id FROM communities WHERE id = 'k-1'"),
    ).toEqual([{ creator_id: 'heir' }]);
    expect(
      await rows(
        "SELECT user_id, assigned_by FROM community_moderators WHERE community_id = 'k-1' AND user_id IN ('founder', 'heir')",
      ),
    ).toEqual([{ user_id: 'founder', assigned_by: 'heir' }]);
    expect(
      await rows(
        "SELECT actor_username, target_id, metadata FROM community_moderation_actions WHERE action = 'ownership_transferred'",
      ),
    ).toEqual([
      {
        actor_username: 'founder',
        target_id: 'heir',
        metadata: { username: 'heir' },
      },
    ]);
    expect(
      await rows(
        "SELECT recipient_id, actor_id, subject_type, subject_id, metadata FROM notifications WHERE type = 'community_ownership_transferred'",
      ),
    ).toEqual([
      {
        recipient_id: 'heir',
        actor_id: 'founder',
        subject_type: 'community',
        subject_id: 'k-1',
        metadata: { actor_username: 'founder', community_name: 'garden' },
      },
    ]);
    // The former owner can no longer transfer it.
    await expect(transfer('member')).rejects.toMatchObject({ status: 403 });
  });

  // A soft deletion: the community keeps its owner and stays.
  it('lets the former owner delete their account afterwards, keeping the community', async () => {
    await expect(
      deletion.deleteOwnAccount('founder', 'password'),
    ).resolves.toBeUndefined();
    expect(
      await rows(
        "SELECT creator_id, deleted_at FROM communities WHERE id = 'k-1'",
      ),
    ).toEqual([{ creator_id: 'heir', deleted_at: null }]);
  });
});
