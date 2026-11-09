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
import { AdminReportsService } from '../admin/admin-reports.service';
import { AuditLogService } from '../admin/audit-log.service';
import { ListReportsDto } from '../admin/dto/list-reports.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { DELETE_PRIVATE_STATE_SQL } from '../users/account-deletion.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Report assignment against a real MySQL server: the trigger pair standing in
// for chk_user_reports_assignment, what ON DELETE SET NULL leaves behind, the
// audit rows, and the plan of "my open reports". Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and drop
// scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('report assignment (MySQL)', () => {
  const database = `report_assignment_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let issued: Array<{ sql: string; values: unknown[] }>;
  let queue: AdminReportsService;

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const assignment = async (id: string) =>
    (
      await rows(
        'SELECT assigned_to, assigned_at, status FROM user_reports WHERE id = ?',
        [id],
      )
    )[0];
  const list = (query: Partial<ListReportsDto>, caller = 'admin') =>
    queue.findAll(
      Object.assign(new ListReportsDto(), { limit: 100, ...query }),
      caller,
    );

  beforeAll(async () => {
    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${snapshot}`,
    );
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash, role) VALUES
        ('admin', 'admin', 'admin@example.test', 'x', 'admin'),
        ('admin2', 'second_admin', 'admin2@example.test', 'x', 'admin'),
        ('doomed', 'doomed_admin', 'doomed@example.test', 'x', 'admin'),
        ('reporter', 'reporter', 'reporter@example.test', 'x', 'user'),
        ('author', 'author', 'author@example.test', 'x', 'user');
      INSERT INTO user_reports (id, reporter_id, reported_user_id, reason, target_type, target_id)
        VALUES
        ('r-1', 'reporter', 'author', 'spam', 'user', 'author'),
        ('r-2', 'reporter', 'author', 'harassment', 'user', 'author'),
        ('r-3', 'reporter', 'author', 'spam', 'user', 'author');
      INSERT INTO admin_actions (id, actor_id, actor_username, action, target_type, target_id)
        VALUES ('old-1', 'admin', 'admin', 'community_updated', 'community', 'c-1');`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    issued = [];
    // Records what the service sends, so the plan test explains the real SQL.
    const recording = {
      execute: (sql: string, values: never) => {
        issued.push({ sql, values });
        return pool.execute(sql, values);
      },
      getConnection: () => pool.getConnection(),
    } as unknown as Pool;
    queue = new AdminReportsService(
      recording,
      new AuditLogService(pool),
      new NotificationsService(pool),
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('refuses an assignee without a timestamp with the CHECK error', async () => {
    await expect(
      connection.query(
        "UPDATE user_reports SET assigned_to = 'admin', assigned_at = NULL WHERE id = 'r-1'",
      ),
    ).rejects.toMatchObject({ errno: 3819 });
  });

  it('assigns, hands over and unassigns, auditing each change', async () => {
    const detail = await queue.assign('r-1', {}, 'admin');
    expect(detail.assigned_to_username).toBe('admin');
    expect((await assignment('r-1')).status).toBe('open');

    const first = (await assignment('r-1')).assigned_at as Date;
    await queue.assign('r-1', {}, 'admin');
    expect((await assignment('r-1')).assigned_at).toEqual(first);

    await queue.assign('r-1', { username: 'second_admin' }, 'admin');
    expect((await assignment('r-1')).assigned_to).toBe('admin2');
    await queue.unassign('r-1', 'admin');
    expect(await assignment('r-1')).toMatchObject({
      assigned_to: null,
      assigned_at: null,
    });

    const audit = await rows(
      `SELECT action, metadata FROM admin_actions
       WHERE target_type = 'report' AND target_id = 'r-1' ORDER BY created_at, action`,
    );
    expect(audit.map((row) => String(row.action)).sort()).toEqual([
      'report_assigned',
      'report_assigned',
      'report_unassigned',
    ]);
    // The existing value kept its meaning through the enum change.
    expect(
      (await rows("SELECT action FROM admin_actions WHERE id = 'old-1'"))[0],
    ).toEqual({
      action: 'community_updated',
    });
  });

  // The hard-delete path leaves assigned_at behind. The CHECK as first
  // proposed, "... OR assigned_to IS NOT NULL", would then refuse every later
  // update of the row; this rule does not.
  it('survives a hard-deleted assignee, reads it as unassigned, and still transitions', async () => {
    await queue.assign('r-2', { username: 'doomed_admin' }, 'admin');
    await connection.query("DELETE FROM users WHERE id = 'doomed'");

    const left = await assignment('r-2');
    expect(left.assigned_to).toBeNull();
    expect(left.assigned_at).not.toBeNull();
    const detail = await queue.findOne('r-2');
    expect(detail).toMatchObject({
      assigned_to_username: null,
      assigned_at: null,
    });
    expect((await list({ assigned: 'none' })).items.map((i) => i.id)).toContain(
      'r-2',
    );
    await queue.updateStatus('r-2', { status: 'rejected' }, 'admin');
    expect((await assignment('r-2')).status).toBe('rejected');
  });

  it('is cleared by account deletion, which anonymises rather than deletes', async () => {
    await queue.assign('r-3', { username: 'second_admin' }, 'admin');
    const unassign = DELETE_PRIVATE_STATE_SQL.find((sql) =>
      sql.includes('user_reports'),
    )!;
    await connection.query(unassign, ['admin2']);
    expect(await assignment('r-3')).toMatchObject({
      assigned_to: null,
      assigned_at: null,
    });
  });

  it('serves "my open reports" from idx_user_reports_assigned', async () => {
    // A mix of assignees and statuses, so the optimizer has a real choice
    // between idx_user_reports_assigned and idx_user_reports_status_created.
    const statuses = ['open', 'under_review', 'resolved', 'rejected'];
    const assignees = ['admin', 'admin2', null];
    const bulk = Array.from({ length: 300 }, (_, index) => {
      const assignee = assignees[index % 3];
      return [
        `bulk-${index}`,
        statuses[index % 4],
        assignee,
        assignee ? new Date() : null,
        new Date(Date.now() - index * 60_000),
        'reporter',
        'author',
        'spam',
        'user',
        'author',
      ];
    });
    // query() expands a nested array into (..), (..) rows.
    await connection.query(
      `INSERT INTO user_reports
         (id, status, assigned_to, assigned_at, created_at,
          reporter_id, reported_user_id, reason, target_type, target_id)
       VALUES ?`,
      [bulk],
    );
    await connection.query('ANALYZE TABLE user_reports');

    issued = [];
    const mine = await list({ assigned: 'me', status: 'open' });
    expect(mine.items.length).toBeGreaterThan(0);
    const listing = issued.find(({ sql }) => sql.includes('ORDER BY'))!;
    const plan = await rows(`EXPLAIN ${listing.sql}`, listing.values);
    expect(plan.find((row) => row.table === 'ur')).toMatchObject({
      type: 'ref',
      key: 'idx_user_reports_assigned',
    });
  });
});
