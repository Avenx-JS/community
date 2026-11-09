import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
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
import { ListOwnReportsDto } from '../reports/dto/list-own-reports.dto';
import { ReportsService } from '../reports/reports.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Report withdrawal against a real MySQL server: the column from
// 030_add_report_withdrawal, the row surviving withdrawal, the
// user_restrictions.report_id link, the freed duplicate slot and the admin
// queue. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that
// may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('report withdrawal (MySQL)', () => {
  const database = `report_withdrawal_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let reports: ReportsService;
  let queue: AdminReportsService;

  const row = async (id: string) =>
    (
      await connection.query<RowDataPacket[]>(
        'SELECT status, withdrawn_at FROM user_reports WHERE id = ?',
        [id],
      )
    )[0][0];
  const file = (target: string, reporter = 'reporter') =>
    reports.create({ target_type: 'post', target, reason: 'spam' }, reporter);
  const own = (reporter: string) =>
    reports.listOwn(reporter, new ListOwnReportsDto());
  const queueIds = async (query: Partial<ListReportsDto> = {}) =>
    (
      await queue.findAll(
        Object.assign(new ListReportsDto(), { limit: 100, ...query }),
        'admin',
      )
    ).items.map((item) => item.id);

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
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('reporter', 'reporter', 'reporter@example.test', 'x'),
        ('second', 'second', 'second@example.test', 'x'),
        ('author', 'author', 'author@example.test', 'x'),
        ('admin', 'admin', 'admin@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c-1', 'author', 'one');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-1', 'One', 'Body', 'author', 'c-1'),
        ('p-2', 'Two', 'Body', 'author', 'c-1'),
        ('p-3', 'Three', 'Body', 'author', 'c-1'),
        ('p-4', 'Four', 'Body', 'author', 'c-1'),
        ('p-removed', 'Removed title', 'Body', 'author', 'c-1');
      UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'admin'
        WHERE id = 'p-removed';`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    reports = new ReportsService(pool);
    queue = new AdminReportsService(
      pool,
      new AuditLogService(pool),
      new NotificationsService(pool),
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('adds a nullable withdrawn_at defaulting to NULL', async () => {
    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT IS_NULLABLE, COLUMN_DEFAULT, DATA_TYPE
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'user_reports'
         AND column_name = 'withdrawn_at'`,
      [database],
    );
    expect(columns[0]).toMatchObject({
      IS_NULLABLE: 'YES',
      DATA_TYPE: 'timestamp',
    });
    expect(columns[0].COLUMN_DEFAULT).toBeNull();
  });

  it('withdraws by state change, keeps the row, and frees the duplicate slot', async () => {
    const { id } = await file('p-1');
    await expect(file('p-1')).rejects.toBeInstanceOf(ConflictException);

    await reports.withdraw(id, 'reporter');

    const after = await row(id);
    expect(after.status).toBe('open');
    expect(after.withdrawn_at).not.toBeNull();
    const again = await file('p-1');
    expect(again.id).not.toBe(id);
    await expect(file('p-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a second withdrawal and another reporter’s, changing nothing', async () => {
    const { id } = await file('p-2');
    await expect(reports.withdraw(id, 'second')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((await row(id)).withdrawn_at).toBeNull();

    await reports.withdraw(id, 'reporter');
    const first = (await row(id)).withdrawn_at as Date;
    await expect(reports.withdraw(id, 'reporter')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect((await row(id)).withdrawn_at).toEqual(first);
  });

  it('keeps a restriction’s report link, and refuses once the report is under review', async () => {
    const open = await file('p-3');
    const reviewed = await file('p-4');
    await connection.query(
      `INSERT INTO user_restrictions (id, user_id, type, reason, created_by, report_id)
       VALUES ('r-open', 'author', 'ban', 'Spam', 'admin', ?),
              ('r-reviewed', 'author', 'ban', 'Spam', 'admin', ?)`,
      [open.id, reviewed.id],
    );
    await queue.updateStatus(reviewed.id, { status: 'under_review' }, 'admin');

    await reports.withdraw(open.id, 'reporter');
    await expect(
      reports.withdraw(reviewed.id, 'reporter'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await row(reviewed.id)).withdrawn_at).toBeNull();

    const [links] = await connection.query<RowDataPacket[]>(
      `SELECT id, report_id FROM user_restrictions
       WHERE id IN ('r-open', 'r-reviewed') ORDER BY id`,
    );
    expect(links).toEqual([
      { id: 'r-open', report_id: open.id },
      { id: 'r-reviewed', report_id: reviewed.id },
    ]);
  });

  it('leaves the queue by default, stays readable, and cannot be transitioned', async () => {
    const { id } = await file('p-1', 'second');
    expect(await queueIds()).toContain(id);

    await reports.withdraw(id, 'second');

    expect(await queueIds()).not.toContain(id);
    expect(await queueIds({ withdrawn: 'include' })).toContain(id);
    expect(await queueIds({ withdrawn: 'only' })).toContain(id);
    expect((await queue.findOne(id)).withdrawn_at).not.toBeNull();
    await expect(
      queue.updateStatus(id, { status: 'rejected' }, 'admin'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await row(id)).status).toBe('open');
  });

  it('lists only the caller’s reports, without moderator fields, labelling only what is public', async () => {
    const removed = await file('p-removed', 'second');
    const listed = await own('second');
    expect(listed.items.every((item) => typeof item.id === 'string')).toBe(
      true,
    );
    expect(listed.items.map((item) => item.id)).toContain(removed.id);
    expect((await own('reporter')).items.map((item) => item.id)).not.toContain(
      removed.id,
    );

    const item = await reports.findOwn(removed.id, 'second');
    expect(item.target_label).toBeNull();
    expect(Object.keys(item).sort()).toEqual([
      'created_at',
      'description',
      'id',
      'reason',
      'status',
      'target_label',
      'target_type',
      'withdrawn_at',
    ]);
    await expect(
      reports.findOwn(removed.id, 'reporter'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
