import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createConnection,
  type Connection,
  type RowDataPacket,
} from 'mysql2/promise';
import { hashCommunityRules } from '../communities/community-rules-hash';

const migrations = resolve(__dirname, '../../../../data/migrations');
const migration = (file: string) =>
  readFileSync(resolve(migrations, file), 'utf8');

// The pre-drop verification query, read from README.md so the test runs
// exactly what operators are told to run (drop-communities-rules.spec.ts
// keeps it identical to 014's guard). It must return zero before 014 runs.
const readme = readFileSync(resolve(__dirname, '../../README.md'), 'utf8');
const VERIFICATION_SQL = /```sql\n([\s\S]*?)```/.exec(
  readme.slice(readme.indexOf('**Pre-drop verification.**')),
)![1];

// Runs migrations 009, 012, 013 and 014 verbatim on a real MySQL server.
// Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may
// create and drop a scratch database; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('dropping communities.rules (MySQL)', () => {
  const database = `drop_rules_${randomBytes(4).toString('hex')}`;
  let connection: Connection;

  const unmigrated = async () => {
    const [rows] = await connection.query<RowDataPacket[]>(VERIFICATION_SQL);
    return Number(rows[0].unmigrated);
  };

  const hasRulesColumn = async () => {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SHOW COLUMNS FROM communities LIKE 'rules'",
    );
    return rows.length > 0;
  };

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
      CREATE TABLE communities (
        id VARCHAR(36) PRIMARY KEY,
        creator_id VARCHAR(36) NOT NULL,
        rules TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE community_subscriptions (
        user_id VARCHAR(36) NOT NULL,
        community_id VARCHAR(36) NOT NULL,
        PRIMARY KEY (user_id, community_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
      );
      INSERT INTO users (id) VALUES ('creator'), ('member');
      INSERT INTO communities (id, creator_id, rules) VALUES
        ('early', 'creator', 'Be kind.'),
        ('blank', 'creator', '  ');`);
    await connection.query(
      migration('009_create_community_rule_documents.sql'),
    );
    await connection.query(
      migration('012_create_community_rule_acceptances.sql'),
    );

    // Created after 009 through the old POST /communities, so its rules
    // never became a document.
    await connection.query(`
      INSERT INTO communities (id, creator_id, rules)
        VALUES ('late', 'creator', 'Grüße 🎉\nNo spam.');
      INSERT INTO community_subscriptions (user_id, community_id)
        VALUES ('member', 'late');`);
  }, 60_000);

  afterAll(async () => {
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('reports a community whose legacy rules have no document', async () => {
    await expect(unmigrated()).resolves.toBe(1);
  });

  it('refuses to drop the column while legacy rules are unmigrated', async () => {
    await expect(
      connection.query(migration('014_drop_communities_rules.sql')),
    ).rejects.toThrow(/legacy_rules_have_documents/);
    await expect(hasRulesColumn()).resolves.toBe(true);
  });

  it('backfills late communities like 009 and 012, idempotently', async () => {
    await connection.query(migration('013_backfill_late_community_rules.sql'));
    await connection.query(migration('013_backfill_late_community_rules.sql'));

    const [documents] = await connection.query<RowDataPacket[]>(
      `SELECT d.community_id, d.version, d.content_hash, d.published_by,
              r.position, r.title, r.body
       FROM community_rule_documents d
       JOIN community_rules r ON r.document_id = d.id
       WHERE d.community_id = 'late'`,
    );
    expect(documents).toEqual([
      expect.objectContaining({
        version: 1,
        published_by: 'creator',
        position: 1,
        title: 'Community rules',
        body: 'Grüße 🎉\nNo spam.',
        content_hash: hashCommunityRules([
          { position: 1, title: 'Community rules', body: 'Grüße 🎉\nNo spam.' },
        ]),
      }),
    ]);

    const [accepted] = await connection.query<RowDataPacket[]>(
      "SELECT user_id FROM community_rule_acceptances WHERE community_id = 'late' ORDER BY user_id",
    );
    expect(accepted.map((row) => row.user_id as string)).toEqual([
      'creator',
      'member',
    ]);
    await expect(unmigrated()).resolves.toBe(0);
  });

  it('refuses to drop while legacy text differs from version 1', async () => {
    await connection.query(
      "UPDATE communities SET rules = 'Be kind!' WHERE id = 'early'",
    );
    await expect(unmigrated()).resolves.toBe(1);
    await expect(
      connection.query(migration('014_drop_communities_rules.sql')),
    ).rejects.toThrow(/legacy_rules_have_documents/);
    await expect(hasRulesColumn()).resolves.toBe(true);

    await connection.query(
      "UPDATE communities SET rules = 'Be kind.' WHERE id = 'early'",
    );
  });

  it('drops the column once verified and keeps every document', async () => {
    await expect(unmigrated()).resolves.toBe(0);

    await connection.query(migration('014_drop_communities_rules.sql'));

    await expect(hasRulesColumn()).resolves.toBe(false);
    const [rules] = await connection.query<RowDataPacket[]>(
      `SELECT d.community_id, r.body
       FROM community_rule_documents d
       JOIN community_rules r ON r.document_id = d.id
       ORDER BY d.community_id`,
    );
    expect(rules).toEqual([
      expect.objectContaining({ community_id: 'early', body: 'Be kind.' }),
      expect.objectContaining({
        community_id: 'late',
        body: 'Grüße 🎉\nNo spam.',
      }),
    ]);
  });
});
