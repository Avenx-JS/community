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
import { AdminCommunitiesService } from '../admin/admin-communities.service';
import { AdminCommunityStaffService } from '../admin/admin-community-staff.service';
import { AuditLogService } from '../admin/audit-log.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { snapshotBefore } from './enum-history';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '044_add_admin_community_ownership';
const REASON = 'The owner is banned; the moderators asked for help';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 044 and every later enum-only migration undone
// (enum-history.ts); the runner then applies them in order.
const preceding = snapshotBefore(snapshot, '044');

// Migration 044 through the real runner over a database at 043, then owner
// and moderator changes on a suspended community on a real server. Opt in
// with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create
// and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('admin community ownership (MySQL)', () => {
  const database = `admin_owner_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let staff: AdminCommunityStaffService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const enums = (name: string) =>
    rows(
      `SELECT table_name AS t, column_type AS type FROM information_schema.columns
       WHERE table_schema = ? AND ((table_name IN ('admin_actions', 'community_moderation_actions') AND column_name = 'action')
         OR (table_name = 'notifications' AND column_name = 'type'))
       ORDER BY table_name`,
      [name],
    );
  const owner = () =>
    rows("SELECT creator_id FROM communities WHERE id = 'k-1'");
  const moderatorsOf = () =>
    rows(
      "SELECT user_id, assigned_by FROM community_moderators WHERE community_id = 'k-1' ORDER BY user_id",
    );

  beforeAll(async () => {
    expect(preceding).not.toMatch(
      /admin_owner_changed|community_owner_changed/,
    );
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

    // A suspended community whose owner is banned from the platform.
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash, role) VALUES
        ('admin', 'root', 'root@example.test', 'x', 'admin'),
        ('founder', 'founder', 'founder@example.test', 'x', 'user'),
        ('heir', 'heir', 'heir@example.test', 'x', 'user'),
        ('member', 'member', 'member@example.test', 'x', 'user'),
        ('banned', 'banned', 'banned@example.test', 'x', 'user'),
        ('suspended', 'suspended', 'suspended@example.test', 'x', 'user');
      INSERT INTO communities (id, creator_id, name, suspended_at, suspended_by, suspension_reason)
        VALUES ('k-1', 'founder', 'garden', UTC_TIMESTAMP(), 'admin', 'Abandoned');
      INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES ('k-1', 'heir', 'founder');
      INSERT INTO community_moderator_invites (community_id, user_id, invited_by) VALUES ('k-1', 'member', 'founder');
      INSERT INTO community_bans (id, community_id, user_id, reason) VALUES ('b-1', 'k-1', 'banned', 'Spam');
      INSERT INTO user_restrictions (id, user_id, type, reason) VALUES ('r-1', 'founder', 'ban', 'Spam network');
      INSERT INTO user_restrictions (id, user_id, type, reason, expires_at)
        VALUES ('r-2', 'suspended', 'suspension', 'Spam', UTC_TIMESTAMP() + INTERVAL 1 DAY);`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    const auditLog = new AuditLogService(pool);
    staff = new AdminCommunityStaffService(
      pool,
      auditLog,
      new CommunityModerationLogService(pool),
      new NotificationsService(pool),
      new AdminCommunitiesService(pool, auditLog),
    );
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  it('applies 044, matching a fresh installation', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await enums(database)).toEqual(await enums(fresh));
  });

  it.each([
    ['an unknown community', 'nope', 'heir', 404],
    ['an unknown account', 'k-1', 'nobody', 404],
    ['the current owner', 'k-1', 'founder', 409],
    ['a platform-suspended account', 'k-1', 'suspended', 409],
    ['an account banned from the community', 'k-1', 'banned', 409],
  ])('refuses %s, changing nothing', async (_, id, username, status) => {
    await expect(
      staff.changeOwner(id, { username, reason: REASON }, 'admin'),
    ).rejects.toMatchObject({ status });
    await expect(
      staff.addModerator(id, { username, reason: REASON }, 'admin'),
    ).rejects.toMatchObject({ status });
    expect(await owner()).toEqual([{ creator_id: 'founder' }]);
    expect(await rows('SELECT id FROM admin_actions')).toEqual([]);
  });

  it('reassigns a suspended community whose owner is banned, without a moderator row for them, in both logs', async () => {
    await expect(
      staff.changeOwner('k-1', { username: 'heir', reason: REASON }, 'admin'),
    ).resolves.toMatchObject({ id: 'k-1', suspended_at: expect.any(String) });

    expect(await owner()).toEqual([{ creator_id: 'heir' }]);
    // The banned founder gets no row; the heir's own row is gone.
    expect(await moderatorsOf()).toEqual([]);
    expect(
      await rows(
        "SELECT actor_username, target_type, target_id, metadata FROM admin_actions WHERE action = 'community_owner_changed'",
      ),
    ).toEqual([
      {
        actor_username: 'root',
        target_type: 'community',
        target_id: 'k-1',
        metadata: {
          community_name: 'garden',
          username: 'heir',
          previous_owner_username: 'founder',
          reason: REASON,
        },
      },
    ]);
    expect(
      await rows(
        "SELECT actor_username, target_id, metadata FROM community_moderation_actions WHERE action = 'admin_owner_changed'",
      ),
    ).toEqual([
      {
        actor_username: 'root',
        target_id: 'heir',
        metadata: { username: 'heir', reason: REASON },
      },
    ]);
    expect(
      await rows(
        "SELECT recipient_id, type, actor_id, metadata FROM notifications WHERE subject_id = 'k-1' ORDER BY type",
      ),
    ).toEqual([
      {
        recipient_id: 'heir',
        type: 'community_ownership_assigned',
        actor_id: null,
        metadata: { community_name: 'garden' },
      },
      {
        recipient_id: 'founder',
        type: 'community_ownership_revoked',
        actor_id: null,
        metadata: { community_name: 'garden' },
      },
    ]);
  });

  it('adds a moderator without an invitation, consuming the pending one, idempotently', async () => {
    await staff.addModerator(
      'k-1',
      { username: 'member', reason: REASON },
      'admin',
    );
    await staff.addModerator(
      'k-1',
      { username: 'member', reason: REASON },
      'admin',
    );
    expect(await moderatorsOf()).toEqual([
      { user_id: 'member', assigned_by: 'admin' },
    ]);
    expect(
      await rows(
        "SELECT user_id FROM community_moderator_invites WHERE community_id = 'k-1'",
      ),
    ).toEqual([]);
    expect(
      await rows(
        "SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'community_moderator_added'",
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('removes a moderator idempotently, but never the owner', async () => {
    await expect(
      staff.removeModerator('k-1', 'heir', REASON, 'admin'),
    ).rejects.toMatchObject({ status: 409 });
    await staff.removeModerator('k-1', 'member', REASON, 'admin');
    await staff.removeModerator('k-1', 'member', REASON, 'admin');
    expect(await moderatorsOf()).toEqual([]);
    expect(
      await rows(
        "SELECT action FROM community_moderation_actions WHERE action LIKE 'admin_moderator_%' ORDER BY action",
      ),
    ).toEqual([
      { action: 'admin_moderator_added' },
      { action: 'admin_moderator_removed' },
    ]);
  });

  it('keeps a previous owner who is not banned as a moderator', async () => {
    await staff.changeOwner(
      'k-1',
      { username: 'member', reason: REASON },
      'admin',
    );
    expect(await moderatorsOf()).toEqual([
      { user_id: 'heir', assigned_by: 'admin' },
    ]);
  });
});
