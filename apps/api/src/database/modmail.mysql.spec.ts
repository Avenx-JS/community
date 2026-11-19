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
import { ModmailService } from '../modmail/modmail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReportsService } from '../reports/reports.service';
import { snapshotBefore } from './enum-history';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '046_create_modmail';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 046 and every later folded migration undone
// (enum-history.ts); the runner then applies them in order.
const preceding = snapshotBefore(snapshot, '046');

// Migration 046 through the real runner, then modmail with the real service
// and a report of a message on a real server. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and
// drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('modmail (MySQL)', () => {
  const database = `modmail_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let modmail: ModmailService;
  let reports: ReportsService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const schema = (name: string) =>
    rows(
      `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS n
       FROM information_schema.columns
       WHERE table_schema = ? AND (table_name IN ('modmail_threads', 'modmail_messages')
         OR (table_name = 'notifications' AND column_name IN ('type', 'subject_type'))
         OR (table_name = 'user_reports' AND column_name = 'target_type'))
       ORDER BY 1, 2`,
      [name],
    );

  beforeAll(async () => {
    expect(preceding).not.toMatch(/modmail/);
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
        ('creator', 'founder', 'founder@example.test', 'x'),
        ('mod', 'mod_jane', 'mod@example.test', 'x'),
        ('muted_mod', 'muted_mod', 'muted@example.test', 'x'),
        ('appellant', 'appellant', 'appellant@example.test', 'x'),
        ('other', 'other_user', 'other@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES ('k-1', 'creator', 'garden');
      INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES
        ('k-1', 'mod', 'creator'), ('k-1', 'muted_mod', 'creator');
      INSERT INTO community_mutes (user_id, community_id) VALUES ('muted_mod', 'k-1');
      INSERT INTO community_bans (id, community_id, user_id, reason) VALUES ('b-1', 'k-1', 'appellant', 'Spam');
      -- A block does not reach modmail, in either direction.
      INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('appellant', 'mod'), ('creator', 'appellant');`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    modmail = new ModmailService(pool, new NotificationsService(pool));
    reports = new ReportsService(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  let threadId: string;

  it('applies 046, matching a fresh installation', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await schema(database)).toEqual(await schema(fresh));
  });

  it("takes a banned user's appeal, once a day, notifying the team but a moderator who muted it", async () => {
    const thread = await modmail.startAsUser('garden', 'appellant', {
      subject: 'About my ban',
      body: 'I think this was a mistake.',
    });
    threadId = thread.id;
    await expect(
      modmail.startAsUser('garden', 'appellant', {
        subject: 'Again',
        body: 'x',
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(
      await rows(
        "SELECT recipient_id, actor_id FROM notifications WHERE type = 'modmail_message' ORDER BY recipient_id",
      ),
    ).toEqual([
      { recipient_id: 'creator', actor_id: null },
      { recipient_id: 'mod', actor_id: null },
    ]);
  });

  it('answers as the team without naming the moderator to the user', async () => {
    await modmail.replyAsModerator('garden', 'mod', threadId, 'We will look.');
    const own = await modmail.getOwn('appellant', threadId);
    expect(own.messages[1]).toMatchObject({
      is_moderator: true,
      author_label: 'moderators of c/garden',
      author_username: null,
    });
    const team = await modmail.getCommunity('garden', 'creator', threadId);
    expect(team.messages[1]).toMatchObject({ author_username: 'mod_jane' });
    expect(
      await rows(
        "SELECT metadata FROM notifications WHERE type = 'modmail_message' AND recipient_id = 'appellant'",
      ),
    ).toEqual([
      {
        metadata: expect.objectContaining({
          sender: 'moderators',
          thread_id: threadId,
        }),
      },
    ]);
  });

  it("archives, lists by status, and reopens on the user's reply", async () => {
    await modmail.setStatus('garden', 'mod', threadId, 'archived');
    expect(
      (await modmail.listCommunity('garden', 'mod', { status: 'archived' }))
        .total,
    ).toBe(1);
    await expect(
      modmail.replyAsUser('appellant', threadId, 'Any news?'),
    ).resolves.toMatchObject({ status: 'open' });
  });

  it('lets the user report a team message, for administrators, naming the moderator to them', async () => {
    const [message] = await rows(
      'SELECT id FROM modmail_messages WHERE is_moderator = TRUE LIMIT 1',
    );
    const report = await reports.create(
      {
        target_type: 'modmail_message',
        target: message.id as string,
        reason: 'harassment',
      } as never,
      'appellant',
    );
    expect(report).toMatchObject({
      target_type: 'modmail_message',
      reported_username: null,
    });
    expect(
      await rows(
        'SELECT reported_user_id, community_id FROM user_reports WHERE id = ?',
        [report.id],
      ),
    ).toEqual([{ reported_user_id: 'mod', community_id: null }]);
    await expect(
      reports.create(
        {
          target_type: 'modmail_message',
          target: message.id as string,
          reason: 'spam',
        } as never,
        'other',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
