import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createConnection,
  type Connection,
  type RowDataPacket,
} from 'mysql2/promise';
import {
  ADMIN_ACTIONS,
  ADMIN_ACTION_TARGETS,
} from '../admin/audit-log.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { removeTriggerRules, runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '025_add_community_suspension';
const enumType = (values: readonly string[]) =>
  `enum(${values.map((value) => `'${value}'`).join(',')})`;

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 025 undone: the suspension columns, foreign key, trigger
// pair and index, the appended enum members, and the version.
const preceding = removeTriggerRules(snapshot, 'chk_communities_suspension')
  .replace(/ {4}suspended_at TIMESTAMP NULL DEFAULT NULL,\r?\n/, '')
  .replace(/ {4}suspended_by VARCHAR\(36\) NULL,\r?\n/, '')
  .replace(/ {4}suspension_reason TEXT NULL,\r?\n/, '')
  .replace(/ {4}CONSTRAINT fk_communities_suspended_by[^\n]*\n/, '')
  .replace(/CREATE INDEX idx_communities_suspended_at[^\n]*\n/, '')
  .replace(
    /'user_role_changed',\r?\n\s*'community_suspended',\r?\n\s*'community_restored',\r?\n\s*'community_updated'/,
    "'user_role_changed'",
  )
  .replace(
    "target_type ENUM('user', 'report', 'restriction', 'community')",
    "target_type ENUM('user', 'report', 'restriction')",
  )
  .replace(/,\r?\n\s*\('025_add_community_suspension'\)/, '');

// Runs migration 025 through the real runner on a real MySQL server, over a
// database at version 024 that already holds admin_actions rows of every
// earlier action. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_*
// credentials that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community suspension (MySQL)', () => {
  const database = `community_suspension_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let firstRun: string[];
  let secondRun: string[];
  let actionsBefore: RowDataPacket[];

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
      `SELECT table_name AS t, column_name AS name, column_type AS type,
              is_nullable AS nullable, column_default AS def
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name IN ('communities', 'admin_actions')
       ORDER BY table_name, column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT table_name AS t, index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name IN ('communities', 'admin_actions')
       GROUP BY table_name, index_name ORDER BY table_name, index_name`,
      [name],
    ),
    constraints: await rows(
      `SELECT table_name AS t, constraint_name AS name, constraint_type AS type
       FROM information_schema.table_constraints
       WHERE table_schema = ? AND table_name IN ('communities', 'admin_actions')
       ORDER BY table_name, constraint_name`,
      [name],
    ),
    // chk_communities_suspension is a trigger pair; compared by name, since
    // the rebuilt history need not create triggers in snapshot order.
    triggers: await rows(
      `SELECT trigger_name AS name, action_timing AS timing,
              event_manipulation AS event, action_statement AS statement
       FROM information_schema.triggers
       WHERE event_object_schema = ? AND event_object_table = 'communities'
       ORDER BY trigger_name`,
      [name],
    ),
  });

  const expectCheckViolation = (sql: string) =>
    expect(connection.query(sql)).rejects.toMatchObject({
      code: 'ER_CHECK_CONSTRAINT_VIOLATED',
    });

  beforeAll(async () => {
    // user_suspended is an older action; only 025's own tokens must be gone.
    expect(preceding).not.toMatch(
      /suspended_at|suspension_reason|chk_communities_suspension|community_restored/,
    );
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
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash, role) VALUES
        ('admin', 'admin', 'admin@example.test', 'x', 'admin'),
        ('other-admin', 'other_admin', 'other@example.test', 'x', 'admin'),
        ('creator', 'creator', 'creator@example.test', 'x', 'user');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c1', 'creator', 'existing'), ('c2', 'creator', 'second');
      INSERT INTO admin_actions
        (id, actor_id, actor_username, action, target_type, target_id, metadata)
      VALUES
        ('a1', 'admin', 'admin', 'report_status_changed', 'report', 'r1', '{"to_status":"resolved"}'),
        ('a2', 'admin', 'admin', 'user_suspended', 'user', 'creator', NULL),
        ('a3', 'admin', 'admin', 'user_banned', 'user', 'creator', NULL),
        ('a4', 'admin', 'admin', 'restriction_lifted', 'restriction', 'x1', NULL),
        ('a5', 'admin', 'admin', 'user_role_changed', 'user', 'creator', NULL);`);
    actionsBefore = await rows(
      'SELECT id, action, target_type, target_id, metadata FROM admin_actions ORDER BY id',
    );

    firstRun = await migrate();
    secondRun = await migrate();
  }, 120_000);

  afterAll(async () => {
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  it('applies 025 once, then skips it', () => {
    expect(firstRun).toEqual([`Applied ${VERSION}`]);
    expect(secondRun).toEqual([]);
  });

  it('matches the snapshot exactly', async () => {
    expect(await schema(database)).toEqual(await schema(fresh));
  });

  it('appends the enum members in order', async () => {
    const columns = await rows(
      `SELECT column_name AS name, column_type AS type
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'admin_actions'
         AND column_name IN ('action', 'target_type')
       ORDER BY column_name`,
      [database],
    );
    expect(columns).toEqual([
      { name: 'action', type: enumType(ADMIN_ACTIONS) },
      { name: 'target_type', type: enumType(ADMIN_ACTION_TARGETS) },
    ]);
  });

  it('keeps every pre-existing admin_actions row exactly', async () => {
    expect(
      await rows(
        'SELECT id, action, target_type, target_id, metadata FROM admin_actions ORDER BY id',
      ),
    ).toEqual(actionsBefore);
    // Stored enum indexes, not only labels, are unchanged.
    expect(
      await rows(
        'SELECT id, action + 0 AS action_index, target_type + 0 AS target_index FROM admin_actions ORDER BY id',
      ),
    ).toEqual([
      { id: 'a1', action_index: 1, target_index: 2 },
      { id: 'a2', action_index: 2, target_index: 1 },
      { id: 'a3', action_index: 3, target_index: 1 },
      { id: 'a4', action_index: 4, target_index: 3 },
      { id: 'a5', action_index: 5, target_index: 1 },
    ]);
  });

  it('accepts the new action and target values', async () => {
    await connection.query(`
      INSERT INTO admin_actions
        (id, actor_id, actor_username, action, target_type, target_id)
      VALUES
        ('n1', 'admin', 'admin', 'community_suspended', 'community', 'c1'),
        ('n2', 'admin', 'admin', 'community_restored', 'community', 'c1'),
        ('n3', 'admin', 'admin', 'community_updated', 'community', 'c1')`);
    expect(
      await rows(
        "SELECT action FROM admin_actions WHERE target_type = 'community' ORDER BY id",
      ),
    ).toEqual([
      { action: 'community_suspended' },
      { action: 'community_restored' },
      { action: 'community_updated' },
    ]);
  });

  it('leaves every existing community unsuspended', async () => {
    expect(
      await rows(
        'SELECT id FROM communities WHERE suspended_at IS NOT NULL OR suspended_by IS NOT NULL OR suspension_reason IS NOT NULL',
      ),
    ).toEqual([]);
  });

  it.each([
    "suspended_by = 'admin'",
    "suspension_reason = 'Spam'",
    "suspended_by = 'admin', suspension_reason = 'Spam'",
  ])('rejects %s without suspended_at', async (assignment) => {
    await expectCheckViolation(
      `UPDATE communities SET ${assignment} WHERE id = 'c2'`,
    );
  });

  it('accepts a timestamp alone, and with its actor and reason', async () => {
    await connection.query(
      "UPDATE communities SET suspended_at = UTC_TIMESTAMP() WHERE id = 'c2'",
    );
    await connection.query(
      "UPDATE communities SET suspended_by = 'other-admin', suspension_reason = 'Spam network' WHERE id = 'c2'",
    );
    await expectCheckViolation(
      "UPDATE communities SET suspended_at = NULL WHERE id = 'c2'",
    );
  });

  it('keeps the suspension when the suspending administrator is deleted', async () => {
    await connection.query("DELETE FROM users WHERE id = 'other-admin'");

    const [row] = await rows(
      "SELECT suspended_at, suspended_by, suspension_reason FROM communities WHERE id = 'c2'",
    );
    expect(row.suspended_at).toBeInstanceOf(Date);
    expect(row.suspended_by).toBeNull();
    expect(row.suspension_reason).toBe('Spam network');
  });
});
