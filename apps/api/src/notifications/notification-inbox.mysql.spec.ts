import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createConnection,
  type Connection,
  type RowDataPacket,
} from 'mysql2/promise';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import {
  buildNotificationListQuery,
  UNREAD_COUNT_SQL,
} from './notification-inbox.service';

const migration = resolve(
  __dirname,
  '../../../../data/migrations/010_create_notifications.sql',
);

// Runs migration 010 on a real MySQL server and checks that EXPLAIN picks one
// of its inbox indexes for the queries the service sends. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and drop
// a scratch database; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('notification inbox query plans (MySQL)', () => {
  const database = `notification_inbox_${randomBytes(4).toString('hex')}`;
  let connection: Connection;

  async function explainKey(sql: string, values: unknown[]) {
    const [plan] = await connection.query<RowDataPacket[]>(
      `EXPLAIN ${sql}`,
      values,
    );
    return plan[0].key as string | null;
  }

  const list = (input: Record<string, unknown>) =>
    buildNotificationListQuery(
      'recipient-7',
      plainToInstance(ListNotificationsDto, input),
    );

  beforeAll(async () => {
    connection = await createConnection({
      host: process.env.MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      multipleStatements: true,
    });
    await connection.query(`CREATE DATABASE ${database}; USE ${database};
      CREATE TABLE users (id VARCHAR(36) PRIMARY KEY);
      CREATE TABLE communities (id VARCHAR(36) PRIMARY KEY);`);
    await connection.query(readFileSync(migration, 'utf8'));

    // Enough rows across many recipients that the optimizer prefers an index.
    const recipients = Array.from({ length: 50 }, (_, i) => `recipient-${i}`);
    await connection.query('INSERT INTO users (id) VALUES ?', [
      recipients.map((id) => [id]),
    ]);
    await connection.query("INSERT INTO communities (id) VALUES ('c-1')");
    const rows = Array.from({ length: 5000 }, (_, i) => [
      `n-${i}`,
      recipients[i % recipients.length],
      i % 2 === 0 ? 'post_comment' : 'community_post',
      i % 2 === 0 ? 'comment' : 'post',
      `s-${i}`,
      'c-1',
      i % 3 === 0 ? new Date() : null,
    ]);
    await connection.query(
      `INSERT INTO notifications
         (id, recipient_id, type, subject_type, subject_id, community_id, read_at)
       VALUES ?`,
      [rows],
    );
    await connection.query('ANALYZE TABLE notifications');
  }, 60_000);

  afterAll(async () => {
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('serves the listing from (recipient_id, created_at, id)', async () => {
    const { sql, values } = list({});
    await expect(explainKey(sql, values)).resolves.toBe(
      'idx_notifications_recipient_created',
    );
  });

  it('serves the unread filter and unread count from (recipient_id, read_at, created_at)', async () => {
    const { sql, values } = list({ read: 'false' });
    await expect(explainKey(sql, values)).resolves.toBe(
      'idx_notifications_recipient_unread',
    );
    await expect(explainKey(UNREAD_COUNT_SQL, ['recipient-7'])).resolves.toBe(
      'idx_notifications_recipient_unread',
    );
  });

  it('serves the type filter from (recipient_id, type, created_at)', async () => {
    const { sql, values } = list({ type: 'post_comment' });
    await expect(explainKey(sql, values)).resolves.toBe(
      'idx_notifications_recipient_type',
    );
  });
});
