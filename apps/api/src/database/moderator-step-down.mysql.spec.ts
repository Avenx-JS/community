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
import { readCommunityRole } from '../communities/community-access';
import { CommunityBanPolicyService } from '../communities/community-ban-policy.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { CommunityModeratorInvitesService } from '../communities/community-moderator-invites.service';
import { ListCommunityModerationActionsDto } from '../communities/dto/list-community-moderation-actions.dto';
import { NotificationsService } from '../notifications/notifications.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '043_add_moderator_step_down';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 043 undone: its header, its version and the two enum
// members it folded into CREATE TABLE.
const preceding = snapshot
  .replace(
    /-- A moderator stepping down \(043_add_moderator_step_down\)\.\r?\n(?:--[^\n]*\r?\n)*\r?\n/,
    '',
  )
  .replace(/,\r?\n\s*\('043_add_moderator_step_down'\)/, '')
  .replace(/,\r?\n\s*'moderator_left'/, '')
  .replace(/,\r?\n\s*'community_moderator_left'/, '');

// Migration 043 through the real runner over a database at 042, then a
// step-down on a real server and the moderator checks after it. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and
// drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('moderator step-down (MySQL)', () => {
  const database = `step_down_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let invites: CommunityModeratorInvitesService;
  let moderationLog: CommunityModerationLogService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const enums = (name: string) =>
    rows(
      `SELECT table_name AS t, column_type AS type FROM information_schema.columns
       WHERE table_schema = ? AND ((table_name = 'community_moderation_actions' AND column_name = 'action')
         OR (table_name = 'notifications' AND column_name = 'type'))
       ORDER BY table_name`,
      [name],
    );
  const readLog = (userId: string) =>
    moderationLog.findAll(
      'garden',
      userId,
      Object.assign(new ListCommunityModerationActionsDto(), {
        page: 1,
        limit: 20,
      }),
    );

  beforeAll(async () => {
    expect(preceding).not.toMatch(/moderator_left/);
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
        ('mod', 'mod_one', 'mod@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES ('k-1', 'founder', 'garden');
      INSERT INTO community_subscriptions (user_id, community_id) VALUES ('mod', 'k-1');
      INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES ('k-1', 'mod', 'founder');
      -- A community ban does not keep anyone in a role.
      INSERT INTO community_bans (id, community_id, user_id, reason) VALUES ('b-1', 'k-1', 'mod', 'Spam');`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    moderationLog = new CommunityModerationLogService(pool);
    invites = new CommunityModeratorInvitesService(
      pool,
      moderationLog,
      new CommunityBanPolicyService(pool),
      new NotificationsService(pool),
    );
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  it('applies 043, matching a fresh installation', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await enums(database)).toEqual(await enums(fresh));
  });

  it('refuses the creator, changing nothing', async () => {
    await expect(invites.stepDown('garden', 'founder')).rejects.toMatchObject({
      status: 409,
    });
    expect(await rows('SELECT user_id FROM community_moderators')).toEqual([
      { user_id: 'mod' },
    ]);
  });

  it('steps down, logged and notified, and ends every moderator power at once', async () => {
    await expect(readLog('mod')).resolves.toMatchObject({ total: 0 });
    expect((await readCommunityRole(pool, 'garden', 'mod')).can_moderate).toBe(
      true,
    );

    await invites.stepDown('garden', 'mod');

    expect(await rows('SELECT user_id FROM community_moderators')).toEqual([]);
    expect((await readCommunityRole(pool, 'garden', 'mod')).can_moderate).toBe(
      false,
    );
    await expect(readLog('mod')).rejects.toMatchObject({ status: 403 });
    await expect(readLog('founder')).resolves.toMatchObject({
      items: [
        {
          action: 'moderator_left',
          actor_username: 'mod_one',
          target_id: 'mod',
          metadata: { username: 'mod_one' },
        },
      ],
    });
    expect(
      await rows(
        "SELECT recipient_id, actor_id, subject_id, metadata FROM notifications WHERE type = 'community_moderator_left'",
      ),
    ).toEqual([
      {
        recipient_id: 'founder',
        actor_id: 'mod',
        subject_id: 'k-1',
        metadata: { actor_username: 'mod_one', community_name: 'garden' },
      },
    ]);
  });

  it('is idempotent', async () => {
    await expect(invites.stepDown('garden', 'mod')).resolves.toBeUndefined();
    expect(
      await rows(
        "SELECT COUNT(*) AS n FROM community_moderation_actions WHERE action = 'moderator_left'",
      ),
    ).toEqual([{ n: 1 }]);
  });
});
