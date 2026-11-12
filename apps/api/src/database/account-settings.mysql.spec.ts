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
import { AuthService } from '../auth/auth.service';
import { EmailVerificationService } from '../auth/email-verification.service';
import { CommunitiesService } from '../communities/communities.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import type { EmailTransport, OutboundMessage } from '../email/email-transport';
import { DataExportService } from '../users/data-export.service';
import { UserPreferencesService } from '../users/user-preferences.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '037_add_account_settings';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 037 undone: its appended block and the version.
const preceding = snapshot
  .replace(
    /-- Account settings \(037_add_account_settings\)\.\r?\n[\s\S]*?(?=-- [^\n]*\(\d{3}_[a-z_]+\)\.\r?\n|CREATE TABLE schema_migrations)/,
    '',
  )
  .replace(/,\r?\n\s*\('037_add_account_settings'\)/, '');

// Migration 037 through the real runner, then the account flows with the
// real services on a real server. Opt in with MYSQL_INTEGRATION_TEST=true and
// MYSQL_* credentials that may create and drop scratch databases; skipped
// otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('account settings (MySQL)', () => {
  const database = `account_settings_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  const inbox: OutboundMessage[] = [];
  const transport: EmailTransport = {
    send: (message: OutboundMessage) => {
      inbox.push(message);
      return Promise.resolve();
    },
  };
  const accepting = {
    assertAcceptedOrThrow: () => Promise.resolve(),
  } as unknown as CommunityRuleAcceptanceService;
  let connection: Connection;
  let pool: Pool;
  let auth: AuthService;
  let emails: EmailVerificationService;
  let preferences: UserPreferencesService;
  let exportsService: DataExportService;
  let communities: CommunitiesService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const flush = () => new Promise((done) => setTimeout(done, 50));
  const codeIn = (message?: OutboundMessage) =>
    /\n\n([A-Za-z0-9_-]{43})\n\n/.exec(message?.text ?? '')?.[1];
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
    "('users', 'auth_sessions', 'email_verification_tokens', 'email_changes', 'user_preferences', 'data_exports')";
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
    expect(preceding).not.toMatch(
      /email_verified_at|email_changes|data_exports/,
    );
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
        ('existing', 'existing', 'existing@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES ('c-1', 'existing', 'garden');`);
    firstRun = await migrate();

    pool = createPool({ ...credentials, database, connectionLimit: 6 });
    auth = new AuthService(pool, transport);
    emails = new EmailVerificationService(pool, transport, auth);
    emails.onModuleInit();
    preferences = new UserPreferencesService(pool);
    exportsService = new DataExportService(pool, preferences);
    communities = new CommunitiesService(
      pool,
      accepting,
      new CommunityModerationLogService(pool),
    );
  }, 240_000);

  afterAll(async () => {
    exportsService?.onModuleDestroy();
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  it('applies 037, matching a fresh installation, with existing accounts unverified', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await schema(database)).toEqual(await schema(fresh));
    expect(
      (
        await rows("SELECT email_verified_at FROM users WHERE id = 'existing'")
      )[0].email_verified_at,
    ).toBeNull();
  });

  let userId: string;
  let firstSession: { accessToken: string; refreshToken: string };

  it('mails a code at registration, stores only its hash, and confirms the address once', async () => {
    const registered = await auth.register(
      {
        username: 'sam',
        email: 'sam@example.test',
        password: 'correct-horse-battery',
      },
      { ipPrefix: '203.0.113.0/24', userAgent: 'Firefox' },
    );
    userId = registered.user.id;
    firstSession = registered;
    await flush();
    const code = codeIn(inbox.find((m) => m.to === 'sam@example.test'))!;
    expect(
      await rows(
        'SELECT * FROM email_verification_tokens WHERE token_hash = ?',
        [code],
      ),
    ).toEqual([]);
    expect(
      await auth.validateAccessTokenState(registered.accessToken),
    ).toMatchObject({ emailVerified: false });

    await expect(emails.verify(code)).resolves.toEqual({
      status: 'verified',
      email: 'sam@example.test',
    });
    await expect(emails.verify(code)).rejects.toMatchObject({ status: 400 });
    expect(
      await auth.validateAccessTokenState(registered.accessToken),
    ).toMatchObject({ emailVerified: true });
  });

  it('changes the address only after the new one confirms', async () => {
    inbox.length = 0;
    await emails.requestEmailChange(
      userId,
      'correct-horse-battery',
      'samuel@example.test',
    );
    await flush();
    expect(
      (await rows('SELECT email FROM users WHERE id = ?', [userId]))[0].email,
    ).toBe('sam@example.test');
    const code = codeIn(inbox.find((m) => m.to === 'samuel@example.test'))!;
    await expect(emails.verify(code)).resolves.toMatchObject({
      status: 'email_changed',
    });
    expect(
      (
        await rows('SELECT email, email_verified_at FROM users WHERE id = ?', [
          userId,
        ])
      )[0],
    ).toMatchObject({
      email: 'samuel@example.test',
    });
    expect(
      await rows('SELECT * FROM email_changes WHERE user_id = ?', [userId]),
    ).toEqual([]);
  });

  it('lists sessions with their network only, and ends one at once', async () => {
    const second = await auth.login(
      { identifier: 'sam', password: 'correct-horse-battery' },
      { ipPrefix: '198.51.100.0/24', userAgent: 'Safari' },
    );
    const listed = await auth.listSessions(userId, firstSession.accessToken);
    expect(listed.items).toHaveLength(2);
    expect(listed.items.find((s) => s.current)).toMatchObject({
      ip_prefix: '203.0.113.0/24',
      user_agent: 'Firefox',
    });
    const other = listed.items.find((s) => !s.current)!;
    await auth.revokeSession(userId, other.id);
    await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({
      status: 401,
    });
    expect((await auth.validateAccessTokenState(second.accessToken)).kind).toBe(
      'invalid',
    );
    expect(
      (await auth.listSessions(userId, firstSession.accessToken)).items,
    ).toHaveLength(1);
  });

  it('applies the default for communities joined afterwards, not to settings already made', async () => {
    await preferences.replace(userId, {
      email_notifications: true,
      new_community_notifications: false,
      show_nsfw: false,
      timezone: 'Europe/Berlin',
      language: 'de',
    });
    await communities.subscribe('garden', userId);
    expect(
      (
        await rows(
          'SELECT new_posts FROM community_notification_preferences WHERE user_id = ?',
          [userId],
        )
      )[0].new_posts,
    ).toBe(0);
  });

  it('exports once, without secrets, and the payload is cleared after the download', async () => {
    const requested = await exportsService.request(userId);
    await flush();
    const result = await exportsService.download(userId, requested.id);
    expect(result.kind).toBe('file');
    const text = (result as { body: Buffer }).body.toString('utf8');
    expect(JSON.parse(text)).toMatchObject({
      account: { username: 'sam', email: 'samuel@example.test' },
    });
    expect(text).not.toMatch(/argon2|token_hash|password/);
    expect(
      (
        await rows('SELECT status, payload FROM data_exports WHERE id = ?', [
          requested.id,
        ])
      )[0],
    ).toEqual({
      status: 'downloaded',
      payload: null,
    });
    await expect(
      exportsService.download(userId, requested.id),
    ).rejects.toMatchObject({ status: 410 });
  });
});
