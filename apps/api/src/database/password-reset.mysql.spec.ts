import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { verify as argon2Verify } from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createConnection,
  createPool,
  type Connection,
  type Pool,
  type RowDataPacket,
} from 'mysql2/promise';
import { AuthService } from '../auth/auth.service';
import type { EmailTransport, OutboundMessage } from '../email/email-transport';
import { AccountDeletionService } from '../users/account-deletion.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '029_create_password_reset_tokens';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 029 undone: the table and its version.
const preceding = snapshot
  .replace(
    /-- Single-use password reset credentials \(029_create_password_reset_tokens\)\.\r?\nCREATE TABLE password_reset_tokens \([\s\S]*?\r?\n\);\r?\n\r?\n/,
    '',
  )
  .replace(/,\r?\n\s*\('029_create_password_reset_tokens'\)/, '');

// Password reset against a real MySQL server: migration 029, the real locks
// under concurrency, expiry on the database clock, the accent-insensitive
// collation, and account deletion. Opt in with MYSQL_INTEGRATION_TEST=true and
// MYSQL_* credentials that may create and drop scratch databases; skipped
// otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('password reset (MySQL)', () => {
  const database = `password_reset_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  const OLD_PASSWORD = 'correct-horse-battery';
  const NEW_PASSWORD = 'brand-new-horse-battery';
  let connection: Connection;
  let pool: Pool;
  let auth: AuthService;
  let sent: OutboundMessage[];
  let firstRun: string[];
  let secondRun: string[];

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };
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
  const schema = async (name: string) => ({
    columns: await rows(
      `SELECT column_name AS name, column_type AS type,
              is_nullable AS nullable, column_default AS def
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'password_reset_tokens'
       ORDER BY column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'password_reset_tokens'
       GROUP BY index_name ORDER BY index_name`,
      [name],
    ),
    foreignKeys: await rows(
      `SELECT k.column_name AS name, k.referenced_table_name AS refers,
              r.delete_rule AS on_delete
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.constraint_schema
        AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = ? AND k.table_name = 'password_reset_tokens'
       ORDER BY k.column_name`,
      [name],
    ),
  });
  const hash = (token: string) =>
    createHash('sha256').update(token).digest('hex');
  const tokenFrom = (message: OutboundMessage) =>
    /[A-Za-z0-9_-]{43}/.exec(message.text)![0];
  const tokenRows = (userId: string) =>
    rows(
      'SELECT token_hash, used_at FROM password_reset_tokens WHERE user_id = ?',
      [userId],
    );
  const storedHash = async (userId: string) =>
    String(
      (await rows('SELECT password_hash FROM users WHERE id = ?', [userId]))[0]
        .password_hash,
    );
  // The token is written after the response, so wait for the email.
  const waitForEmails = async (count: number) => {
    for (let attempt = 0; attempt < 200 && sent.length < count; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(sent).toHaveLength(count);
  };
  const requestToken = async (email: string) => {
    const before = sent.length;
    await auth.forgotPassword(email);
    await waitForEmails(before + 1);
    return tokenFrom(sent[before]);
  };

  beforeAll(async () => {
    expect(preceding).not.toContain('password_reset_tokens');
    expect(preceding).not.toContain(VERSION);

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
    firstRun = await migrate();
    secondRun = await migrate();

    pool = createPool({ ...credentials, database, connectionLimit: 8 });
    const transport: EmailTransport = {
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    };
    auth = new AuthService(pool, transport);
    await auth.register({
      username: 'reset_user',
      email: 'reset@example.test',
      password: OLD_PASSWORD,
    });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  let userId: string;
  beforeEach(async () => {
    sent = [];
    await connection.query('DELETE FROM password_reset_tokens');
    const [user] = await rows(
      "SELECT id FROM users WHERE username = 'reset_user'",
    );
    userId = String(user.id);
  });

  describe('migration 029', () => {
    it('applies once, then skips', () => {
      expect(firstRun).toEqual([`Applied ${VERSION}`]);
      expect(secondRun).toEqual([]);
    });

    it('matches the snapshot exactly', async () => {
      expect(await schema(database)).toEqual(await schema(fresh));
    });

    it('creates the key, both indexes and the cascading key', async () => {
      const { indexes, foreignKeys } = await schema(database);
      expect(indexes).toEqual(
        expect.arrayContaining([
          { name: 'PRIMARY', columns: 'token_hash' },
          { name: 'idx_password_reset_tokens_user_id', columns: 'user_id' },
          {
            name: 'idx_password_reset_tokens_expires_at',
            columns: 'expires_at',
          },
        ]),
      );
      expect(foreignKeys).toEqual([
        { name: 'user_id', refers: 'users', on_delete: 'CASCADE' },
      ]);
    });
  });

  describe('forgot', () => {
    it('stores one hash, expiring in an hour on the database clock', async () => {
      const token = await requestToken('reset@example.test');
      const [row] = await rows(
        `SELECT token_hash, used_at,
                TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), expires_at) AS minutes
         FROM password_reset_tokens WHERE user_id = ?`,
        [userId],
      );
      expect(row).toMatchObject({ token_hash: hash(token), used_at: null });
      expect(Number(row.minutes)).toBeGreaterThanOrEqual(59);
      expect(Number(row.minutes)).toBeLessThanOrEqual(60);
    });

    it('invalidates earlier tokens', async () => {
      const first = await requestToken('reset@example.test');
      const second = await requestToken('reset@example.test');
      const stored = await tokenRows(userId);
      expect(stored).toHaveLength(2);
      for (const row of stored) {
        expect(row.token_hash === hash(second)).toBe(row.used_at === null);
      }
      expect(first).not.toBe(second);
    });

    it('leaves exactly one live token after a burst, without a deadlock', async () => {
      await Promise.all(
        Array.from({ length: 6 }, () =>
          auth.forgotPassword('reset@example.test'),
        ),
      );
      await waitForEmails(6);
      const live = (await tokenRows(userId)).filter((r) => r.used_at === null);
      expect(live).toHaveLength(1);
      expect(await tokenRows(userId)).toHaveLength(6);
    });

    // This server's collation really does match the variant, which is the
    // whole reason for the exact comparison.
    it('treats a collation-equal accent variant as unknown', async () => {
      const [match] = await rows(
        'SELECT COUNT(*) AS n FROM users WHERE email = ?',
        ['rését@example.test'],
      );
      expect(Number(match.n)).toBe(1);

      await auth.forgotPassword('rését@example.test');
      await new Promise((done) => setTimeout(done, 100));
      expect(sent).toEqual([]);
      expect(await tokenRows(userId)).toEqual([]);
    });
  });

  describe('reset', () => {
    it('replaces the hash and consumes the token', async () => {
      const token = await requestToken('reset@example.test');
      await auth.resetPassword(token, NEW_PASSWORD);

      await expect(
        argon2Verify(await storedHash(userId), NEW_PASSWORD),
      ).resolves.toBe(true);
      await expect(
        auth.resetPassword(token, OLD_PASSWORD),
      ).rejects.toMatchObject({
        status: 400,
      });
      // Back to the old password for the other tests.
      await auth.resetPassword(
        await requestToken('reset@example.test'),
        OLD_PASSWORD,
      );
    });

    it('revokes every session and refresh token', async () => {
      const session = await auth.login({
        identifier: 'reset_user',
        password: OLD_PASSWORD,
      });
      await auth.resetPassword(
        await requestToken('reset@example.test'),
        OLD_PASSWORD,
      );
      await expect(
        auth.validateAccessToken(session.accessToken),
      ).resolves.toBeNull();
      await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({
        status: 401,
      });
    });

    // Against the real query: a stub cannot see an ambiguous column.
    it('validates an access token on the real join, and keeps a restriction’s state', async () => {
      const session = await auth.login({
        identifier: 'reset_user',
        password: OLD_PASSWORD,
      });
      await expect(
        auth.validateAccessTokenState(session.accessToken),
      ).resolves.toEqual({ kind: 'valid', userId });

      await connection.query(
        "INSERT INTO user_restrictions (id, user_id, type, reason) VALUES ('r-reset', ?, 'ban', 'test')",
        [userId],
      );
      await expect(
        auth.validateAccessTokenState(session.accessToken),
      ).resolves.toEqual({
        kind: 'restricted',
        userId,
        restriction: { type: 'ban', expires_at: null },
      });

      // A restricted account may reset, and is still refused at login.
      await auth.resetPassword(
        await requestToken('reset@example.test'),
        OLD_PASSWORD,
      );
      await expect(
        auth.login({ identifier: 'reset_user', password: OLD_PASSWORD }),
      ).rejects.toMatchObject({ status: 403 });

      await connection.query(
        "DELETE FROM user_restrictions WHERE id = 'r-reset'",
      );
    });

    it('lets exactly one of many concurrent resets win', async () => {
      const token = await requestToken('reset@example.test');
      const candidates = ['first', 'second', 'third', 'fourth'].map(
        (name) => `${name}-horse-battery-staple`,
      );
      const results = await Promise.allSettled(
        candidates.map((password) => auth.resetPassword(token, password)),
      );

      const won = results.findIndex((r) => r.status === 'fulfilled');
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({ status: 400 });
        }
      }
      await expect(
        argon2Verify(await storedHash(userId), candidates[won]),
      ).resolves.toBe(true);
      await auth.resetPassword(
        await requestToken('reset@example.test'),
        OLD_PASSWORD,
      );
    }, 30_000);

    // Each locks the users row before the token rows.
    it('does not deadlock when a request and a reset race for one account', async () => {
      for (let round = 0; round < 20; round += 1) {
        const token = await requestToken('reset@example.test');
        const before = sent.length;
        const results = await Promise.allSettled([
          auth.resetPassword(token, OLD_PASSWORD),
          auth.forgotPassword('reset@example.test'),
        ]);
        await waitForEmails(before + 1);
        for (const result of results) {
          if (result.status === 'rejected') {
            // The request invalidated the token first: the generic 400.
            expect(result.reason).toMatchObject({ status: 400 });
          }
        }
      }
    }, 60_000);

    it('refuses a token past expires_at, judged on the database clock', async () => {
      const token = await requestToken('reset@example.test');
      const before = await storedHash(userId);
      await connection.query(
        'UPDATE password_reset_tokens SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE token_hash = ?',
        [hash(token)],
      );
      await expect(
        auth.resetPassword(token, NEW_PASSWORD),
      ).rejects.toMatchObject({
        status: 400,
      });
      expect(await storedHash(userId)).toBe(before);
    });
  });

  describe('deleting an account', () => {
    const createAccount = async (id: string) => {
      await connection.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
        [id, id.replace(/-/g, '_'), `${id}@example.test`, 'x'],
      );
    };

    it('cascades when the users row is hard-deleted', async () => {
      await createAccount('hard-gone');
      await requestToken('hard-gone@example.test');
      await connection.query("DELETE FROM users WHERE id = 'hard-gone'");
      expect(await tokenRows('hard-gone')).toEqual([]);
    });

    // Anonymising fires no cascade, so without the explicit delete this link
    // would overwrite the deleted account's placeholder hash.
    it('removes the tokens when deleted through the API, and the link no longer works', async () => {
      await createAccount('self-gone');
      const token = await requestToken('self-gone@example.test');
      const deletion = new AccountDeletionService(pool, {
        passwordMatches: () => Promise.resolve(true),
        revokeAllSessions: () => Promise.resolve(),
      } as unknown as AuthService);
      await deletion.deleteOwnAccount('self-gone', 'x');
      const placeholder = await storedHash('self-gone');

      expect(await tokenRows('self-gone')).toEqual([]);
      await expect(
        auth.resetPassword(token, NEW_PASSWORD),
      ).rejects.toMatchObject({
        status: 400,
      });
      expect(await storedHash('self-gone')).toBe(placeholder);
    });
  });
});
