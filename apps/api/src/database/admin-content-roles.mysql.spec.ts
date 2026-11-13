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
import { AdminAnalyticsService } from '../admin/admin-analytics.service';
import { AdminContentService } from '../admin/admin-content.service';
import { AdminRolesService } from '../admin/admin-roles.service';
import { AuditLogService } from '../admin/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '041_add_admin_content_and_roles';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 041 undone: its appended block, its version, and the
// admin_actions members it folded into CREATE TABLE.
const preceding = snapshot
  .replace(
    /-- Admin content removal, role administration and analytics indexes \(041_add_admin_content_and_roles\)\.\r?\n[\s\S]*?(?=-- [^\n]*\(\d{3}_[a-z_]+\)\.\r?\n|CREATE TABLE schema_migrations)/,
    '',
  )
  .replace(/,\r?\n\s*\('041_add_admin_content_and_roles'\)/, '')
  .replace(
    /'report_unassigned',\r?\n\s*'post_removed',\r?\n\s*'post_restored',\r?\n\s*'comment_removed',\r?\n\s*'comment_restored'/,
    "'report_unassigned'",
  )
  .replace(
    "ENUM('user', 'report', 'restriction', 'community', 'post', 'comment')",
    "ENUM('user', 'report', 'restriction', 'community')",
  );

// Migration 041 through the real runner over a database at 040 holding a
// moderator's removal, then the admin content, role and analytics
// statements on a real server. Opt in with MYSQL_INTEGRATION_TEST=true and
// MYSQL_* credentials that may create and drop scratch databases.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('admin content and roles (MySQL)', () => {
  const database = `admin_content_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let content: AdminContentService;
  let roles: AdminRolesService;
  let analytics: AdminAnalyticsService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const TABLES = "('posts', 'comments', 'votes', 'admin_actions')";
  const schema = async (name: string) => ({
    columns: await rows(
      `SELECT table_name AS t, column_name AS name, column_type AS type, is_nullable AS nullable, column_default AS def
       FROM information_schema.columns WHERE table_schema = ? AND table_name IN ${TABLES}
       ORDER BY table_name, column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT table_name AS t, index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics WHERE table_schema = ? AND table_name IN ${TABLES}
       GROUP BY table_name, index_name ORDER BY table_name, index_name`,
      [name],
    ),
    checks: await rows(
      `SELECT tc.table_name AS t, cc.constraint_name AS name, cc.check_clause AS clause
       FROM information_schema.check_constraints cc
       JOIN information_schema.table_constraints tc
         ON tc.constraint_schema = cc.constraint_schema AND tc.constraint_name = cc.constraint_name
       WHERE cc.constraint_schema = ? AND tc.table_name IN ${TABLES}
       ORDER BY cc.constraint_name`,
      [name],
    ),
  });

  beforeAll(async () => {
    // community_moderation_actions has always had post_removed; the admin
    // targets and the new column are 041's own.
    expect(preceding).not.toMatch(
      /removed_by_admin|idx_votes_created|'community', 'post', 'comment'\)/,
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
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash, role) VALUES
        ('root', 'root', 'root@example.test', 'x', 'admin'),
        ('second', 'second', 'second@example.test', 'x', 'admin'),
        ('sam', 'sam', 'sam@example.test', 'x', 'user'),
        ('mod', 'mod', 'mod@example.test', 'x', 'user');
      INSERT INTO communities (id, creator_id, name, suspended_at, suspended_by, suspension_reason)
        VALUES ('k-1', 'mod', 'garden', UTC_TIMESTAMP(), 'root', 'Spam network');
      INSERT INTO community_subscriptions (user_id, community_id) VALUES ('sam', 'k-1');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-1', 'Tomatoes', 'Body', 'sam', 'k-1'),
        ('p-2', 'Beans', 'Body', 'sam', 'k-1');
      UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'mod', removal_reason = 'Off-topic' WHERE id = 'p-2';
      INSERT INTO comments (id, post_id, author_id, content) VALUES ('m-1', 'p-1', 'sam', 'A comment');`);
    firstRun = (
      await (async () => {
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
        return log;
      })()
    ).filter((line) => !line.startsWith('Skipped'));

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    const auditLog = new AuditLogService(pool);
    content = new AdminContentService(
      pool,
      auditLog,
      new NotificationsService(pool),
    );
    roles = new AdminRolesService(pool, auditLog);
    analytics = new AdminAnalyticsService(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  it('applies 041, matching a fresh installation, keeping the moderator removal a moderator one', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await schema(database)).toEqual(await schema(fresh));
    expect(
      await rows("SELECT removed_by_admin FROM posts WHERE id = 'p-2'"),
    ).toEqual([{ removed_by_admin: 0 }]);
  });

  it('lists and acts on content in a suspended community, audited with the reason', async () => {
    const listed = await content.findPosts({
      state: 'any',
      community_state: 'suspended',
      page: 1,
      limit: 20,
      sort: 'new',
    });
    expect(listed.total).toBe(2);

    await expect(
      content.removePost('p-2', { reason: 'Escalated' }, 'root'),
    ).resolves.toMatchObject({
      removal: { source: 'admin', reason: 'Escalated' },
    });
    await expect(
      content.removeComment('m-1', { reason: 'Doxxing' }, 'root'),
    ).resolves.toMatchObject({ removal: { source: 'admin' } });
    expect(
      await rows(
        'SELECT action, target_type, target_id, metadata FROM admin_actions ORDER BY created_at, action',
      ),
    ).toEqual([
      {
        action: 'comment_removed',
        target_type: 'comment',
        target_id: 'm-1',
        metadata: {
          community_name: 'garden',
          previous_state: 'visible',
          reason: 'Doxxing',
        },
      },
      {
        action: 'post_removed',
        target_type: 'post',
        target_id: 'p-2',
        metadata: {
          community_name: 'garden',
          previous_state: 'moderator_removed',
          reason: 'Escalated',
        },
      },
    ]);
  });

  // The CHECK constraints refuse a moderator's restore statement on an
  // administrator's removal, whatever the application does.
  it("refuses a moderator's restore statement in the database", async () => {
    await expect(
      connection.query(
        "UPDATE posts SET removed_at = NULL, removed_by = NULL, removal_reason = NULL WHERE id = 'p-2'",
      ),
    ).rejects.toMatchObject({ errno: 3819 });
    await expect(
      content.restorePost('p-2', { reason: 'Appeal upheld' }, 'root'),
    ).resolves.toMatchObject({ removal: null });
  });

  it('changes roles under lock and always keeps an administrator', async () => {
    await expect(
      roles.assign('sam', 'moderator', 'Triage', 'root'),
    ).resolves.toMatchObject({ role: 'moderator' });
    await expect(
      roles.revoke('second', 'admin', 'Rotation', 'root'),
    ).resolves.toMatchObject({ role: 'user' });
    // root is now the only administrator and cannot leave the seat.
    await expect(
      roles.revoke('root', 'admin', 'x', 'root'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      roles.assign('root', 'moderator', 'x', 'second'),
    ).rejects.toMatchObject({ status: 403 });
    expect(await rows("SELECT id FROM users WHERE role = 'admin'")).toEqual([
      { id: 'root' },
    ]);
  });

  it('runs the analytics statements', async () => {
    const range = {
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 60_000),
    };
    const contentMetrics = await analytics.contentMetrics(range, 'day');
    expect(contentMetrics.totals).toMatchObject({ posts: 2, comments: 1 });
    expect(contentMetrics.removals_by_source).toEqual({
      moderator: 0,
      admin: 1,
    });
    const communityMetrics = await analytics.communityMetrics(range, 'week');
    expect(communityMetrics.totals).toMatchObject({
      total_communities: 1,
      suspended_communities: 1,
      active_communities: 1,
    });
    expect(communityMetrics.members_distribution['1-9']).toBe(1);
  });
});
