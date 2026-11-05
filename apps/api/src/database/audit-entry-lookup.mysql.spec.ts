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
import { AdminAuditLogService } from '../admin/admin-audit-log.service';
import { ListAdminActionsDto } from '../admin/dto/list-admin-actions.dto';
import { runSqlScript } from './sql-script';

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Runs GET /admin/audit-log/:id's lookup on a real MySQL server: the plan is
// a primary-key const lookup, and an entry whose actor was deleted (FK set to
// NULL) and whose target never existed still comes back whole. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and
// drop a scratch database; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('audit entry lookup (MySQL)', () => {
  const database = `audit_entry_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let service: AdminAuditLogService;
  const issued: { sql: string; values: unknown[] }[] = [];

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };

  beforeAll(async () => {
    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${snapshot}`,
    );

    // 2000 entries by one administrator against targets that do not exist;
    // every tenth has NULL metadata. Deleting the administrator afterwards
    // sets actor_id to NULL through the foreign key, as account deletion does.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash, role)
        VALUES ('admin-id', 'departed_admin', 'admin@example.test', 'x', 'admin');
      INSERT INTO admin_actions
        (id, actor_id, actor_username, action, target_type, target_id,
         metadata, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
        SELECT CONCAT('a', n), 'admin-id', 'departed_admin', 'user_banned',
               'user', CONCAT('gone-', n),
               IF(n % 10 = 0, NULL,
                  JSON_OBJECT('restriction_id', CONCAT('r', n), 'report_id', NULL)),
               TIMESTAMP('2026-01-01 00:00:00') + INTERVAL n MINUTE
        FROM seq;
      DELETE FROM users WHERE id = 'admin-id';
      ANALYZE TABLE admin_actions;`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    const recording = {
      execute: (sql: string, values: unknown[]) => {
        issued.push({ sql, values });
        return pool.execute(sql, values as never);
      },
    };
    service = new AdminAuditLogService(recording as unknown as Pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('plans the lookup as a primary-key const read', async () => {
    issued.length = 0;
    await service.findOne('a1234');

    const [statement] = issued;
    const plan = await rows(`EXPLAIN ${statement.sql}`, statement.values);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      table: 'admin_actions',
      type: 'const',
      key: 'PRIMARY',
    });
  });

  it('returns an entry with a deleted actor and a missing target in full', async () => {
    await expect(service.findOne('a1234')).resolves.toEqual({
      id: 'a1234',
      actor_username: 'departed_admin',
      actor_id: null,
      action: 'user_banned',
      target_type: 'user',
      target_id: 'gone-1234',
      metadata: { restriction_id: 'r1234', report_id: null },
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    });
  });

  it('returns NULL metadata as null', async () => {
    const item = await service.findOne('a1230');
    expect(item).toHaveProperty('metadata', null);
  });

  it('matches the list item for the same entry', async () => {
    const listed = await service.findAll(
      Object.assign(new ListAdminActionsDto(), {
        target_type: 'user',
        target_id: 'gone-1234',
      }),
    );
    expect(listed.items).toHaveLength(1);
    await expect(service.findOne('a1234')).resolves.toStrictEqual(
      listed.items[0],
    );
  });

  it('returns 404 for an unknown id', async () => {
    await expect(service.findOne('a9999')).rejects.toMatchObject({
      status: 404,
    });
  });
});
