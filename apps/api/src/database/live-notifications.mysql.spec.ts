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
import { NotificationInboxService } from '../notifications/notification-inbox.service';
import { SessionEvents } from '../auth/session-events';
import { NotificationStreamService } from '../notifications/notification-stream.service';
import {
  DEFAULT_PUSH_ALLOWED_HOSTS,
  type PushConfig,
  type PushRequest,
} from '../notifications/web-push/push-config';
import { PushDispatcherService } from '../notifications/web-push/push-dispatcher.service';
import { PushSubscriptionsService } from '../notifications/web-push/push-subscriptions.service';
import { generateVapidKeys } from '../notifications/web-push/web-push-crypto';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '040_add_live_notifications';
const UA_PUBLIC =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 040 undone: its appended block and the version.
const preceding = snapshot
  .replace(
    /-- Live notifications: push subscriptions, stream tickets and push dispatch \(040_add_live_notifications\)\.\r?\n[\s\S]*?(?=-- [^\n]*\(\d{3}_[a-z_]+\)\.\r?\n|CREATE TABLE schema_migrations)/,
    '',
  )
  .replace(/,\r?\n\s*\('040_add_live_notifications'\)/, '');

// Migration 040 through the real runner over a database at 039 holding an
// inbox, then push dispatch and the stream's statements on a real server.
// Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may
// create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('live notifications (MySQL)', () => {
  const database = `live_notifications_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  const config: PushConfig = {
    vapid: { ...generateVapidKeys(), subject: 'mailto:ops@example.org' },
    allowedHosts: DEFAULT_PUSH_ALLOWED_HOSTS,
    ttlSeconds: 60,
    dispatchIntervalSeconds: 5,
    batchSize: 50,
    maxAgeSeconds: 3600,
    maxFailures: 2,
    perAccount: 10,
  };
  const pushes: PushRequest[] = [];
  let status = 201;
  let connection: Connection;
  let pool: Pool;
  let dispatcher: PushDispatcherService;
  let subscriptions: PushSubscriptionsService;
  let streams: NotificationStreamService;
  let inbox: NotificationInboxService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const notify = (
    id: string,
    recipient: string,
    type = 'post_comment',
    community: string | null = null,
    actor: string | null = 'alex',
  ) =>
    connection.query(
      `INSERT INTO notifications (id, recipient_id, type, actor_id, subject_type, subject_id, community_id)
       VALUES (?, ?, ?, ?, 'post', 'p-1', ?)`,
      [id, recipient, type, actor, community],
    );
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
  const TABLES =
    "('notifications', 'push_subscriptions', 'notification_stream_tickets', 'user_preferences')";
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
  });

  beforeAll(async () => {
    expect(preceding).not.toMatch(/push_subscriptions|push_dispatched_at/);
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
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('sam', 'sam', 'sam@example.test', 'x'),
        ('alex', 'alex', 'alex@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES ('k-1', 'alex', 'garden');`);
    await notify('n-before', 'sam');
    firstRun = await migrate();

    pool = createPool({ ...credentials, database, connectionLimit: 6 });
    dispatcher = new PushDispatcherService(pool, config, {
      send: (push) => {
        pushes.push(push);
        return Promise.resolve({ status });
      },
    });
    subscriptions = new PushSubscriptionsService(pool, config);
    inbox = new NotificationInboxService(pool);
    streams = new NotificationStreamService(pool, new SessionEvents(), inbox);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  it('applies 040, matching a fresh installation, without a push backlog', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await schema(database)).toEqual(await schema(fresh));
    expect(
      await rows(
        'SELECT id FROM notifications WHERE push_dispatched_at IS NULL',
      ),
    ).toEqual([]);
  });

  it('pushes each new notification once, honouring the preferences', async () => {
    await subscriptions.register(
      'sam',
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/sam',
        keys: { p256dh: UA_PUBLIC, auth: AUTH },
      },
      'Firefox',
    );
    await connection.query(
      "INSERT INTO community_subscriptions (user_id, community_id) VALUES ('sam', 'k-1');" +
        "INSERT INTO community_notification_preferences (user_id, community_id, new_posts) VALUES ('sam', 'k-1', FALSE)",
    );
    await notify('n-1', 'sam');
    await notify('n-muted', 'sam', 'community_post', 'k-1');

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({
      claimed: 2,
      sent: 1,
      removed: 0,
    });
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      claimed: 0,
    });
    expect(pushes).toHaveLength(1);

    await connection.query(
      "INSERT INTO user_preferences (user_id, push_notifications) VALUES ('sam', FALSE) ON DUPLICATE KEY UPDATE push_notifications = FALSE",
    );
    await notify('n-off', 'sam', 'comment_reply');
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      claimed: 1,
      sent: 0,
    });
    await connection.query(
      "UPDATE user_preferences SET push_notifications = TRUE WHERE user_id = 'sam'",
    );
  });

  it('removes a subscription the push service reports gone', async () => {
    status = 410;
    await notify('n-gone', 'sam', 'report_resolved', null, null);
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      removed: 1,
    });
    expect(await rows('SELECT * FROM push_subscriptions')).toEqual([]);
  });

  it('redeems a stream ticket once, while its session lives, and reads the stream statements', async () => {
    await connection.query(
      "INSERT INTO auth_sessions (token_hash, user_id, session_id, expires_at) VALUES (REPEAT('a', 64), 'sam', 's-1', UTC_TIMESTAMP() + INTERVAL 1 HOUR)",
    );
    const { ticket } = await streams.mintTicket('sam', 'unused');
    await connection.query(
      "UPDATE notification_stream_tickets SET token_hash = REPEAT('a', 64)",
    );
    await expect(streams.redeemTicket(ticket)).resolves.toEqual({
      userId: 'sam',
      tokenHash: 'a'.repeat(64),
    });
    await expect(streams.redeemTicket(ticket)).resolves.toBeNull();

    await streams.poll();
    await expect(inbox.removeAll('sam')).resolves.toMatchObject({
      deleted: expect.any(Number),
    });
    await expect(inbox.removeAll('sam')).resolves.toEqual({ deleted: 0 });
  });
});
