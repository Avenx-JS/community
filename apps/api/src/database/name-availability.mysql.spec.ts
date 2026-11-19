import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createConnection,
  createPool,
  type Connection,
  type Pool,
} from 'mysql2/promise';
import { NameAvailabilityService } from '../common/name-availability.service';
import {
  ANONYMISE_ACCOUNT_SQL,
  deletedEmail,
  deletedUsername,
} from '../users/account-deletion.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// What the availability checks rely on, on a real server: the columns'
// collation compares case-insensitively, account deletion releases a
// username, community deletion does not release a name. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and
// drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('name availability (MySQL)', () => {
  const database = `availability_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let service: NameAvailabilityService;

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
        ('alice-id', 'Alice', 'alice@example.test', 'x'),
        ('gone-id', 'gone_user', 'gone@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('k-1', 'alice-id', 'Garden'),
        ('k-2', 'alice-id', 'old_garden');
      UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = 'alice-id' WHERE id = 'k-2';`);
    // The rename account deletion performs.
    await connection.query(ANONYMISE_ACCOUNT_SQL, [
      deletedUsername('gone-id'),
      deletedEmail('gone-id'),
      'deleted',
      'gone-id',
    ]);
    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    service = new NameAvailabilityService(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('compares usernames as the unique index does, case-insensitively', async () => {
    await expect(service.username('alice')).resolves.toEqual({
      available: false,
      reason: 'taken',
    });
    await expect(
      connection.query(
        "INSERT INTO users (id, username, email, password_hash) VALUES ('x', 'ALICE', 'x@example.test', 'x')",
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it("releases a deleted account's username", async () => {
    await expect(service.username('gone_user')).resolves.toEqual({
      available: true,
    });
  });

  it('keeps a deleted community name taken, case-insensitively', async () => {
    await expect(service.communityName('garden')).resolves.toEqual({
      available: false,
      reason: 'taken',
    });
    await expect(service.communityName('OLD_GARDEN')).resolves.toEqual({
      available: false,
      reason: 'taken',
    });
    await expect(service.communityName('new_garden')).resolves.toEqual({
      available: true,
    });
  });
});
