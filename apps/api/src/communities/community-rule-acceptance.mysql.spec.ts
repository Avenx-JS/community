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
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';

const migrations = resolve(__dirname, '../../../../data/migrations');

interface AcceptanceRow extends RowDataPacket {
  user_id: string;
  community_id: string;
  version: number;
  accepted_at: Date;
}

// Runs migrations 009 and 012 verbatim over a fixture on a real MySQL server.
// Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may
// create and drop a scratch database; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community rule acceptances (MySQL)', () => {
  const database = `rule_acceptance_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let admin: Connection;
  let pool: Pool;
  let service: CommunityRuleAcceptanceService;

  async function acceptances(where = '1 = 1') {
    const [rows] = await pool.query<AcceptanceRow[]>(
      `SELECT a.user_id, a.community_id, d.version, a.accepted_at
       FROM community_rule_acceptances a
       JOIN community_rule_documents d ON d.id = a.document_id
       WHERE ${where}
       ORDER BY a.community_id, d.version, a.user_id`,
    );
    return rows;
  }

  beforeAll(async () => {
    admin = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await admin.query(`CREATE DATABASE ${database}; USE ${database};
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
      INSERT INTO users (id) VALUES
        ('creator-1'), ('creator-2'), ('member-a'), ('member-b'),
        ('late-joiner');
      INSERT INTO communities (id, creator_id, rules) VALUES
        ('with-rules', 'creator-1', 'Be kind.'),
        ('without-rules', 'creator-2', NULL);
      INSERT INTO community_subscriptions (user_id, community_id) VALUES
        ('member-a', 'with-rules'), ('member-b', 'with-rules'),
        ('member-a', 'without-rules');`);
    for (const file of [
      '009_create_community_rule_documents.sql',
      '012_create_community_rule_acceptances.sql',
    ]) {
      await admin.query(readFileSync(resolve(migrations, file), 'utf8'));
    }
    await admin.query(
      "INSERT INTO community_subscriptions VALUES ('late-joiner', 'with-rules')",
    );

    // Same options as DatabaseModule, so mysql2's default flags apply.
    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    service = new CommunityRuleAcceptanceService(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin?.end();
  });

  it('grandfathers only pre-existing members of communities with backfilled rules', async () => {
    expect(
      (await acceptances()).map(({ user_id, community_id, version }) => [
        user_id,
        community_id,
        version,
      ]),
    ).toEqual([
      ['creator-1', 'with-rules', 1],
      ['member-a', 'with-rules', 1],
      ['member-b', 'with-rules', 1],
    ]);

    for (const user of ['creator-1', 'member-a', 'member-b']) {
      expect(
        (await service.getState(user, 'with-rules')).acceptanceRequired,
      ).toBe(false);
    }
    expect(await service.getState('late-joiner', 'with-rules')).toMatchObject({
      currentVersion: 1,
      acceptanceRequired: true,
    });
    expect(await service.getState('member-a', 'without-rules')).toEqual({
      currentVersion: null,
      currentDocumentId: null,
      acceptedAt: null,
      acceptanceRequired: false,
    });
  });

  it('keeps one row and the original time when an acceptance repeats', async () => {
    await expect(service.accept('late-joiner', 'with-rules', 1)).resolves.toBe(
      true,
    );
    // Backdate the row so an overwrite by the repeat would be visible.
    await pool.query(
      "UPDATE community_rule_acceptances SET accepted_at = accepted_at - INTERVAL 1 DAY WHERE user_id = 'late-joiner'",
    );
    const [original] = await acceptances("a.user_id = 'late-joiner'");

    await expect(service.accept('late-joiner', 'with-rules', 1)).resolves.toBe(
      true,
    );
    const rows = await acceptances("a.user_id = 'late-joiner'");
    expect(rows).toHaveLength(1);
    expect(rows[0].accepted_at).toEqual(original.accepted_at);
    expect(
      (await service.getState('late-joiner', 'with-rules')).acceptanceRequired,
    ).toBe(false);
  });

  it('inserts nothing for a community and version that do not exist together', async () => {
    const before = (await acceptances()).length;

    await expect(service.accept('member-a', 'without-rules', 1)).resolves.toBe(
      false,
    );
    await expect(service.accept('member-a', 'with-rules', 99)).resolves.toBe(
      false,
    );
    expect(await acceptances()).toHaveLength(before);
  });

  it('requires a newer version by number even if its timestamp is older, and keeps history', async () => {
    await pool.query(`INSERT INTO community_rule_documents
      (id, community_id, version, content_hash, published_at)
      VALUES ('with-rules-v2', 'with-rules', 2, REPEAT('0', 64), '2000-01-01 00:00:00')`);

    expect(await service.getState('member-a', 'with-rules')).toMatchObject({
      currentVersion: 2,
      currentDocumentId: 'with-rules-v2',
      acceptanceRequired: true,
    });

    await expect(service.accept('member-a', 'with-rules', 2)).resolves.toBe(
      true,
    );
    expect(
      (await service.getState('member-a', 'with-rules')).acceptanceRequired,
    ).toBe(false);
    expect(
      (await acceptances("a.user_id = 'member-a'")).map(({ version }) =>
        Number(version),
      ),
    ).toEqual([1, 2]);
  });

  it('runs on a given connection inside its transaction', async () => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await service.accept('member-b', 'with-rules', 2, connection);
      expect(
        (await service.getState('member-b', 'with-rules', connection))
          .acceptanceRequired,
      ).toBe(false);
      await connection.rollback();
    } finally {
      connection.release();
    }

    expect(
      (await service.getState('member-b', 'with-rules')).acceptanceRequired,
    ).toBe(true);
  });

  it('cascades from documents, users and communities', async () => {
    await pool.query(
      "DELETE FROM community_rule_documents WHERE id = 'with-rules-v2'",
    );
    expect(await acceptances('d.version = 2')).toHaveLength(0);

    await pool.query("DELETE FROM users WHERE id = 'member-b'");
    expect(await acceptances("a.user_id = 'member-b'")).toHaveLength(0);

    await pool.query("DELETE FROM communities WHERE id = 'with-rules'");
    expect(await acceptances()).toHaveLength(0);
  });
});
