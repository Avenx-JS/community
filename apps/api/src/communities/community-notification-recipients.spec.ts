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
  eligibleRecipients,
  recipientFixture,
} from '../../test/fakes/community-notification-recipients';
import {
  COMMUNITY_POST_FAN_OUT_SQL,
  COMMUNITY_POST_RECIPIENT_COUNT_SQL,
} from '../notifications/notifications.service';
import { COMMUNITY_NEW_POST_RECIPIENTS_SQL } from './community-notification-recipients';

const repository = resolve(__dirname, '../../../..');

describe('community new-post recipient contract', () => {
  it('is documented verbatim in the README', () => {
    const readme = readFileSync(
      resolve(repository, 'apps/api/README.md'),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(readme).toContain(COMMUNITY_NEW_POST_RECIPIENTS_SQL);
  });

  it('is reused unchanged by the community_post fan-out', () => {
    expect(COMMUNITY_POST_RECIPIENT_COUNT_SQL).toContain(
      `(${COMMUNITY_NEW_POST_RECIPIENTS_SQL} AND s.user_id <> ?)`,
    );
    expect(COMMUNITY_POST_FAN_OUT_SQL).toContain(
      `(${COMMUNITY_NEW_POST_RECIPIENTS_SQL} AND s.user_id <> ?)`,
    );
  });

  it('is what the in-memory fake evaluates for the shared fixture', () => {
    const { subscriptions, preferences, communityId } = recipientFixture;

    expect(
      eligibleRecipients(subscriptions, preferences, communityId).sort(),
    ).toEqual(recipientFixture.eligible);
  });
});

// Evaluates the contract against a real MySQL server. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and drop
// a scratch database; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community new-post recipient contract (MySQL)', () => {
  const database = `notification_contract_${randomBytes(4).toString('hex')}`;
  const { communityId, author } = recipientFixture;
  let connection: Connection;

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
      CREATE TABLE communities (id VARCHAR(36) PRIMARY KEY);
      CREATE TABLE community_subscriptions (
        user_id VARCHAR(36) NOT NULL,
        community_id VARCHAR(36) NOT NULL,
        PRIMARY KEY (user_id, community_id)
      );`);
    for (const migration of [
      '010_create_notifications.sql',
      '011_create_community_notification_preferences.sql',
    ]) {
      await connection.query(
        readFileSync(resolve(repository, 'data/migrations', migration), 'utf8'),
      );
    }
    await connection.query('INSERT INTO users (id) VALUES ?', [
      recipientFixture.users.map((id) => [id]),
    ]);
    await connection.query('INSERT INTO communities (id) VALUES ?', [
      recipientFixture.communities.map((id) => [id]),
    ]);
    await connection.query(
      'INSERT INTO community_subscriptions (user_id, community_id) VALUES ?',
      [recipientFixture.subscriptions],
    );
    await connection.query(
      'INSERT INTO community_notification_preferences (user_id, community_id, new_posts) VALUES ?',
      [recipientFixture.preferences],
    );
  });

  afterAll(async () => {
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('selects members unless muted, and never non-members', async () => {
    const [rows] = await connection.execute(
      `${COMMUNITY_NEW_POST_RECIPIENTS_SQL} ORDER BY s.user_id`,
      [communityId],
    );

    expect(
      (rows as Array<{ user_id: string }>).map((row) => row.user_id),
    ).toEqual(recipientFixture.eligible);
  });

  it('counts and fans out to the same members, excluding the author, idempotently', async () => {
    const [counts] = await connection.execute<RowDataPacket[]>(
      COMMUNITY_POST_RECIPIENT_COUNT_SQL,
      [communityId, author],
    );
    expect(Number(counts[0].recipients)).toBe(recipientFixture.notified.length);

    const values = [
      author,
      'post-1',
      communityId,
      JSON.stringify({ post_title: 'Hello' }),
      communityId,
      author,
    ];
    await connection.execute(COMMUNITY_POST_FAN_OUT_SQL, values);
    await connection.execute(COMMUNITY_POST_FAN_OUT_SQL, values);

    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT id, recipient_id, actor_id, subject_type, subject_id, community_id, metadata FROM notifications WHERE type = 'community_post' ORDER BY recipient_id",
    );
    expect(rows.map((row) => row.recipient_id as string)).toEqual(
      recipientFixture.notified,
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_id: author,
        subject_type: 'post',
        subject_id: 'post-1',
        community_id: communityId,
        metadata: { post_title: 'Hello' },
      });
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});
