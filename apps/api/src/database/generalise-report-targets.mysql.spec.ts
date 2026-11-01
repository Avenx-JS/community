import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
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
import type { AuditLogService } from '../admin/audit-log.service';
import type { ListReportsDto } from '../admin/dto/list-reports.dto';
import type { NotificationsService } from '../notifications/notifications.service';
import { ReportsService } from '../reports/reports.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';

const migrations = resolve(__dirname, '../../../../data/migrations');
const migration = (file: string) =>
  readFileSync(resolve(migrations, file), 'utf8');
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

const VERSION = '016_generalise_report_targets';

// Runs migrations 002, 008 and then 016 through the real runner on a real
// MySQL server, over a fixture of existing user reports. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and drop
// scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('generalised report targets (MySQL)', () => {
  const database = `report_targets_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let reportsBefore: RowDataPacket[];

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
    return log;
  };

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };

  const queue = () =>
    new AdminReportsService(
      pool,
      {} as AuditLogService,
      {} as NotificationsService,
    ).findAll({ limit: 100 } as ListReportsDto);

  // Column shape, named indexes, foreign-key rules and checks of user_reports.
  const shape = async (schema: string) => ({
    columns: await rows(
      `SELECT column_name AS name, column_type AS type,
              is_nullable AS nullable, column_default AS default_value
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'user_reports'
       ORDER BY column_name`,
      [schema],
    ),
    indexes: await rows(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'user_reports'
         AND index_name LIKE 'idx\\_%'
       GROUP BY index_name ORDER BY index_name`,
      [schema],
    ),
    foreignKeys: await rows(
      `SELECT k.column_name AS name, r.delete_rule AS on_delete
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.table_schema
        AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = ? AND k.table_name = 'user_reports'
       ORDER BY k.column_name`,
      [schema],
    ),
    checks: await rows(
      `SELECT c.constraint_name AS name, c.check_clause AS clause
       FROM information_schema.check_constraints c
       JOIN information_schema.table_constraints t
         ON t.constraint_schema = c.constraint_schema
        AND t.constraint_name = c.constraint_name
       WHERE t.table_schema = ? AND t.table_name = 'user_reports'
       ORDER BY c.constraint_name`,
      [schema],
    ),
  });

  beforeAll(async () => {
    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await connection.query(
      `CREATE DATABASE ${fresh}; USE ${fresh}; ${snapshot}`,
    );
    await connection.query(`CREATE DATABASE ${database}; USE ${database};
      CREATE TABLE users (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE
      );
      CREATE TABLE posts (
        id VARCHAR(36) PRIMARY KEY,
        author_id VARCHAR(36) NOT NULL,
        FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE comments (
        id VARCHAR(36) PRIMARY KEY,
        author_id VARCHAR(36) NOT NULL,
        FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
      );`);
    await connection.query(migration('002_create_user_reports.sql'));
    await connection.query(migration('008_add_report_analytics_indexes.sql'));

    // Every other migration is already recorded, so the runner applies 016
    // alone, as on an installation at version 015.
    const earlier = (await loadMigrations(migrations))
      .map(({ version }) => version)
      .filter((version) => version !== VERSION);
    await connection.query(
      `CREATE TABLE schema_migrations (
         version VARCHAR(64) PRIMARY KEY,
         applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
       );
       INSERT INTO schema_migrations (version) VALUES ?;`,
      [earlier.map((version) => [version])],
    );

    // Existing user reports, with and without evidence, plus 60 more accounts
    // so the target index is selective.
    await connection.query(`
      INSERT INTO users (id, username) VALUES
        ('alice', 'alice'), ('bob', 'bob'), ('carol', 'carol');
      INSERT INTO users (id, username)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 60)
        SELECT CONCAT('user-', n), CONCAT('user_', n) FROM seq;
      INSERT INTO posts (id, author_id) VALUES
        ('post-1', 'bob'), ('post-2', 'bob'), ('post-3', 'carol');
      INSERT INTO comments (id, author_id) VALUES ('comment-1', 'bob');
      INSERT INTO user_reports
        (id, reporter_id, reported_user_id, reason, context_type, context_id,
         status, created_at)
      VALUES
        ('r-plain', 'alice', 'bob', 'spam', NULL, NULL, 'open', '2026-01-01 00:00:00'),
        ('r-post', 'alice', 'bob', 'harassment', 'post', 'post-1', 'under_review', '2026-01-02 00:00:00'),
        ('r-comment', 'carol', 'bob', 'other', 'comment', 'comment-1', 'resolved', '2026-01-03 00:00:00'),
        ('r-anonymous', NULL, 'carol', 'spam', NULL, NULL, 'rejected', '2026-01-04 00:00:00');
      INSERT INTO user_reports (id, reporter_id, reported_user_id, reason, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 60)
        SELECT CONCAT('r-bulk-', n), 'alice', CONCAT('user-', n), 'spam', '2026-01-05 00:00:00'
        FROM seq;`);
    reportsBefore = await rows('SELECT * FROM user_reports ORDER BY id');

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  it('applies 016 to a database at 015 once, and skips it on a second run', async () => {
    const queueBefore = await queue();

    const first = await migrate();
    expect(first.filter((line) => !line.startsWith('Skipped'))).toEqual([
      `Applied ${VERSION}`,
    ]);
    const second = await migrate();
    expect(second.filter((line) => !line.startsWith('Skipped'))).toEqual([]);

    const [recorded] = await rows(
      'SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?',
      [VERSION],
    );
    expect(Number(recorded.n)).toBe(1);

    // The admin queue reads the same rows the same way.
    await expect(queue()).resolves.toEqual(queueBefore);
  }, 60_000);

  it('targets every existing report at its account and leaves every other value alone', async () => {
    const after = await rows('SELECT * FROM user_reports ORDER BY id');

    expect(after).toHaveLength(reportsBefore.length);
    after.forEach((report, index) => {
      const { target_type, target_id, target_author_id, ...rest } = report;
      expect(rest).toEqual({ ...reportsBefore[index] });
      expect(target_type).toBe('user');
      expect(target_id).toBe(reportsBefore[index].reported_user_id);
      expect(target_author_id).toBeNull();
    });
    const [nulls] = await rows(
      'SELECT COUNT(*) AS n FROM user_reports WHERE target_id IS NULL',
    );
    expect(Number(nulls.n)).toBe(0);
  });

  it('has the final shape, which the full-install snapshot matches', async () => {
    const migrated = await shape(database);

    expect(migrated.columns).toEqual(
      expect.arrayContaining([
        {
          name: 'reported_user_id',
          type: 'varchar(36)',
          nullable: 'YES',
          default_value: null,
        },
        {
          name: 'target_author_id',
          type: 'varchar(36)',
          nullable: 'YES',
          default_value: null,
        },
        {
          name: 'target_id',
          type: 'varchar(36)',
          nullable: 'NO',
          default_value: null,
        },
        {
          name: 'target_type',
          type: "enum('user','post','comment','community')",
          nullable: 'NO',
          default_value: 'user',
        },
      ]),
    );
    expect(migrated.indexes).toEqual(
      expect.arrayContaining([
        {
          name: 'idx_user_reports_target',
          columns: 'target_type,target_id,status',
        },
        {
          name: 'idx_user_reports_target_type_created',
          columns: 'target_type,created_at',
        },
        // The account and analytics indexes survive.
        {
          name: 'idx_user_reports_reported_user',
          columns: 'reported_user_id,status',
        },
        {
          name: 'idx_user_reports_reviewed',
          columns: 'reviewed_at,status,resolution,created_at',
        },
      ]),
    );
    expect(migrated.foreignKeys).toEqual([
      { name: 'reported_user_id', on_delete: 'SET NULL' },
      { name: 'reporter_id', on_delete: 'SET NULL' },
      { name: 'reviewed_by', on_delete: 'SET NULL' },
      { name: 'target_author_id', on_delete: 'SET NULL' },
    ]);
    expect(migrated.checks.map((check) => check.name as string)).toEqual([
      'chk_user_reports_context',
      'chk_user_reports_not_self',
    ]);

    await expect(shape(fresh)).resolves.toEqual(migrated);
  });

  it('plans a target lookup on idx_user_reports_target', async () => {
    await connection.query('ANALYZE TABLE user_reports');
    const [plan] = await rows(
      `EXPLAIN SELECT id FROM user_reports
       WHERE target_type = ? AND target_id = ?
         AND status IN ('open', 'under_review')`,
      ['user', 'user-7'],
    );
    expect(plan).toMatchObject({ key: 'idx_user_reports_target' });
  });

  it('refuses self-reporting one’s own post through the existing check', async () => {
    await expect(
      connection.query(`
        INSERT INTO user_reports
          (id, reporter_id, reported_user_id, reason, target_type, target_id, target_author_id)
        VALUES ('r-self-post', 'bob', 'bob', 'spam', 'post', 'post-1', 'bob')`),
    ).rejects.toThrow(/chk_user_reports_not_self/);

    // A community has no account, so the check passes vacuously.
    await connection.query(`
      INSERT INTO user_reports (id, reporter_id, reason, target_type, target_id)
      VALUES ('r-community', 'bob', 'other', 'community', 'community-1')`);
  });

  it('still requires the evidence pair to be complete', async () => {
    await expect(
      connection.query(`
        INSERT INTO user_reports
          (id, reporter_id, reported_user_id, reason, context_type, target_id)
        VALUES ('r-half-context', 'alice', 'bob', 'spam', 'post', 'bob')`),
    ).rejects.toThrow(/chk_user_reports_context/);
  });

  it('keys duplicates on the target and evidence through the real service', async () => {
    const reports = new ReportsService(pool);
    const submit = (contextId?: string) =>
      reports.create(
        {
          username: 'bob',
          reason: 'spam',
          ...(contextId
            ? { context_type: 'post' as const, context_id: contextId }
            : {}),
        },
        'carol',
      );

    const created = await submit('post-2');
    const [row] = await rows(
      'SELECT target_type, target_id, reported_user_id FROM user_reports WHERE id = ?',
      [created.id],
    );
    expect(row).toEqual({
      target_type: 'user',
      target_id: 'bob',
      reported_user_id: 'bob',
    });

    await expect(submit('post-2')).rejects.toBeInstanceOf(ConflictException);
    // Two different posts by one author do not collide.
    await expect(submit('post-1')).resolves.toMatchObject({ status: 'open' });
  });

  it('renders a report whose target is gone, without joining the target', async () => {
    await connection.query(`
      INSERT INTO user_reports
        (id, reporter_id, reported_user_id, reason, target_type, target_id, target_author_id)
      VALUES ('r-gone', 'alice', 'carol', 'spam', 'post', 'deleted-post', 'carol')`);

    const { items } = await queue();
    expect(items.map((item) => item.id)).toContain('r-gone');
  });

  it('keeps reports when an author is deleted, nulling only the account links', async () => {
    await connection.query(`
      INSERT INTO user_reports
        (id, reporter_id, reported_user_id, reason, target_type, target_id, target_author_id)
      VALUES ('r-by-carol', 'alice', 'carol', 'spam', 'post', 'post-3', 'carol')`);

    await connection.query("DELETE FROM users WHERE id = 'carol'");

    const kept = await rows(
      `SELECT id, reporter_id, reported_user_id, target_type, target_id, target_author_id
       FROM user_reports WHERE id IN ('r-by-carol', 'r-gone', 'r-anonymous', 'r-comment')
       ORDER BY id`,
    );
    expect(kept).toEqual([
      {
        id: 'r-anonymous',
        reporter_id: null,
        reported_user_id: null,
        target_type: 'user',
        target_id: 'carol',
        target_author_id: null,
      },
      {
        id: 'r-by-carol',
        reporter_id: 'alice',
        reported_user_id: null,
        target_type: 'post',
        target_id: 'post-3',
        target_author_id: null,
      },
      // carol filed this one; only the reporter link is cleared.
      {
        id: 'r-comment',
        reporter_id: null,
        reported_user_id: 'bob',
        target_type: 'user',
        target_id: 'bob',
        target_author_id: null,
      },
      {
        id: 'r-gone',
        reporter_id: 'alice',
        reported_user_id: null,
        target_type: 'post',
        target_id: 'deleted-post',
        target_author_id: null,
      },
    ]);

    // Reports without an account leave the queue rather than breaking it.
    const { items } = await queue();
    expect(items.map((item) => item.id)).not.toContain('r-by-carol');
    expect(items.map((item) => item.id)).toContain('r-comment');
  });
});
