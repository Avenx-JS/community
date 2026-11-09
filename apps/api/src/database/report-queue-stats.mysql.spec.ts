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
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// GET /admin/reports/stats against a real MySQL server: the plan of each
// aggregate, and its agreement with the queue's own totals. Seeded with a mix
// of statuses, assignees and target types, mostly closed reports as a real
// table would be, so the optimiser has a reason to prefer an index over a
// scan. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that
// may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('report queue stats (MySQL)', () => {
  const database = `report_queue_stats_${randomBytes(4).toString('hex')}`;
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
  const total = async (query: Partial<ListReportsDto>) =>
    (
      await queue.findAll(
        Object.assign(new ListReportsDto(), { limit: 1, ...query }),
        'admin',
      )
    ).total;

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
        ('reporter', 'reporter', 'reporter@example.test', 'x', 'user'),
        ('author', 'author', 'author@example.test', 'x', 'user');`);

    // 2000 reports: one in ten open, a few under review, the rest closed.
    const reasons = ['spam', 'harassment', 'hate_speech', 'other'];
    const types = ['user', 'post', 'comment', 'community'];
    const bulk = Array.from({ length: 2000 }, (_, index) => {
      const status =
        index % 10 === 0
          ? 'open'
          : index % 25 === 1
            ? 'under_review'
            : index % 2 === 0
              ? 'resolved'
              : 'rejected';
      const assignee = index % 3 === 0 ? null : ['admin', 'admin2'][index % 2];
      return [
        `bulk-${index}`,
        status,
        status === 'resolved' ? 'no_action' : null,
        reasons[index % reasons.length],
        types[index % types.length],
        'author',
        assignee,
        assignee ? new Date() : null,
        // Every fortieth open report withdrawn.
        status === 'open' && index % 40 === 0 ? new Date() : null,
        new Date(Date.UTC(2026, 0, 1) + index * 3_600_000),
        'reporter',
        'author',
      ];
    });
    await connection.query(
      `INSERT INTO user_reports
         (id, status, resolution, reason, target_type, target_id, assigned_to,
          assigned_at, withdrawn_at, created_at, reporter_id, reported_user_id)
       VALUES ?`,
      [bulk],
    );
    await connection.query('ANALYZE TABLE user_reports');

    pool = createPool({ ...credentials, database, connectionLimit: 8 });
    issued = [];
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

  it('agrees with the queue’s own totals', async () => {
    const stats = await queue.queueStats('admin');
    expect(stats.open).toBeGreaterThan(0);
    expect(stats.open).toBe(await total({ status: 'open' }));
    expect(stats.under_review).toBe(await total({ status: 'under_review' }));
    expect(stats.unassigned_open).toBe(
      await total({ status: 'open', assigned: 'none' }),
    );
    expect(stats.assigned_to_me_open).toBe(
      await total({ status: 'open', assigned: 'me' }),
    );
    expect(stats.withdrawn_open).toBe(
      await total({ status: 'open', withdrawn: 'only' }),
    );
    const sum = (counts: Record<string, number>) =>
      Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum(stats.by_reason)).toBe(stats.open);
    expect(sum(stats.by_target_type)).toBe(stats.open);

    const [oldest] = (
      await queue.findAll(
        Object.assign(new ListReportsDto(), {
          status: 'open',
          sort: 'oldest',
          limit: 1,
        }),
        'admin',
      )
    ).items;
    expect(stats.oldest_open_at).toBe(oldest.created_at);
  });

  // Every aggregate reads through an index. by_target_type has no index
  // leading on status and target_type together; the optimiser serves it from
  // idx_user_reports_status_created (status = 'open') rather than scanning,
  // which is why no index was added for it.
  it('serves every aggregate from an index, never a full scan', async () => {
    issued = [];
    await queue.queueStats('admin');
    expect(issued).toHaveLength(7);

    const plans = await Promise.all(
      issued.map(async ({ sql, values }) => ({
        sql,
        plan: await rows(`EXPLAIN ${sql}`, values),
      })),
    );
    for (const { sql, plan } of plans) {
      for (const row of plan) {
        expect([sql, row.type]).not.toEqual([sql, 'ALL']);
        expect([sql, row.key]).not.toEqual([sql, null]);
      }
    }
    const keyOf = (fragment: string) =>
      plans.find(({ sql }) => sql.includes(fragment))!.plan[0].key as string;
    expect(keyOf('assigned_to = ?')).toBe('idx_user_reports_assigned');
    expect(keyOf('assigned_to IS NULL')).toBe('idx_user_reports_assigned');
    expect(keyOf('ORDER BY created_at ASC LIMIT 1')).toBe(
      'idx_user_reports_status_created',
    );
    expect(keyOf('GROUP BY status')).toBe('idx_user_reports_status_created');
  });
});
