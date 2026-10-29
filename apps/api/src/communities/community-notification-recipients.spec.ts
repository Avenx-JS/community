import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConnection, type Connection } from 'mysql2/promise';
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
});

// Evaluates the contract against a real MySQL server. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and drop
// a scratch database; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community new-post recipient contract (MySQL)', () => {
  const database = `notification_contract_${randomBytes(4).toString('hex')}`;
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
    await connection.query(
      readFileSync(
        resolve(
          repository,
          'data/migrations/011_create_community_notification_preferences.sql',
        ),
        'utf8',
      ),
    );
    await connection.query(`
      INSERT INTO users (id) VALUES
        ('member-default'), ('member-on'), ('member-off'), ('outsider-on'),
        ('other-community-member');
      INSERT INTO communities (id) VALUES ('c1'), ('c2');
      INSERT INTO community_subscriptions (user_id, community_id) VALUES
        ('member-default', 'c1'), ('member-on', 'c1'), ('member-off', 'c1'),
        ('other-community-member', 'c2');
      INSERT INTO community_notification_preferences
        (user_id, community_id, new_posts) VALUES
        ('member-on', 'c1', TRUE), ('member-off', 'c1', FALSE),
        ('outsider-on', 'c1', TRUE), ('other-community-member', 'c1', TRUE);`);
  });

  afterAll(async () => {
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('selects members unless muted, and never non-members', async () => {
    const [rows] = await connection.execute(
      `${COMMUNITY_NEW_POST_RECIPIENTS_SQL} ORDER BY s.user_id`,
      ['c1'],
    );

    expect(
      (rows as Array<{ user_id: string }>).map((row) => row.user_id),
    ).toEqual(['member-default', 'member-on']);
  });
});
