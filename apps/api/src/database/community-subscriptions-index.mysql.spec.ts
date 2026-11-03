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
import { CommunitiesService } from '../communities/communities.service';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { ListCommunityMembersDto } from '../communities/dto/list-community-members.dto';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '024_add_community_subscriptions_community_index';
const INDEX = 'idx_community_subscriptions_community_created';

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 024 undone: its index and its version.
const preceding = snapshot
  .replace(
    /CREATE INDEX idx_community_subscriptions_community_created\r?\n[^;]*;\r?\n/,
    '',
  )
  .replace(
    /,\r?\n\s*\('024_add_community_subscriptions_community_index'\)/,
    '',
  );

// Runs migration 024 through the real runner on a real MySQL server, then
// checks that the member listing is planned on the new index without a
// filesort. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials
// that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community subscriptions index (MySQL)', () => {
  const database = `subscriptions_index_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let communities: CommunitiesService;
  const issued: { sql: string; values: unknown[] }[] = [];
  let firstRun: string[];
  let secondRun: string[];

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

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };

  const indexes = (schema: string) =>
    rows(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'community_subscriptions'
       GROUP BY index_name ORDER BY index_name`,
      [schema],
    );

  beforeAll(async () => {
    expect(preceding).not.toContain(INDEX);
    expect(preceding).not.toContain(VERSION);

    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await connection.query(
      `CREATE DATABASE ${fresh}; USE ${fresh}; ${snapshot}`,
    );
    await connection.query(
      `CREATE DATABASE ${database}; USE ${database}; ${preceding}`,
    );
    firstRun = await migrate();
    secondRun = await migrate();

    // 2000 users subscribed to 20 communities, so one community holds a few
    // percent of the table and a scan is never the cheaper plan. created_at
    // repeats in pairs so the user_id tiebreaker decides real orders.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
        SELECT CONCAT('u', LPAD(n, 4, '0')), CONCAT('user_', n),
               CONCAT('u', n, '@example.test'), 'x'
        FROM seq;
      INSERT INTO communities (id, creator_id, name)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20)
        SELECT CONCAT('c', n), 'u0001', CONCAT('c', n) FROM seq;
      INSERT INTO community_subscriptions (user_id, community_id, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
        SELECT CONCAT('u', LPAD(n, 4, '0')), CONCAT('c', 1 + n % 20),
               TIMESTAMP('2026-01-01 00:00:00') + INTERVAL FLOOR(n / 2) MINUTE
        FROM seq;
      INSERT INTO community_moderators (community_id, user_id, assigned_by)
        VALUES ('c1', 'u0020', 'u0001');
      ANALYZE TABLE users, community_subscriptions, community_moderators;`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    const recording = {
      execute: (sql: string, values: unknown[]) => {
        issued.push({ sql, values });
        return pool.execute(sql, values as never);
      },
    };
    communities = new CommunitiesService(
      recording as unknown as Pool,
      {} as CommunityRuleAcceptanceService,
      {} as CommunityModerationLogService,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  it('applies 024 once, then skips it', () => {
    expect(firstRun).toEqual([`Applied ${VERSION}`]);
    expect(secondRun).toEqual([]);
  });

  it('creates the same indexes as the snapshot, keeping the foreign-key index', async () => {
    const migrated = await indexes(database);
    expect(migrated).toEqual(await indexes(fresh));
    expect(migrated).toEqual(
      expect.arrayContaining([
        { name: INDEX, columns: 'community_id,created_at,user_id' },
        { name: 'community_id', columns: 'community_id' },
      ]),
    );
  });

  it.each([
    ['new', {}],
    ['oldest', { sort: 'oldest' as const }],
  ])(
    'plans the %s member listing on the index without a filesort',
    async (_sort, overrides) => {
      issued.length = 0;
      await communities.listMembers(
        'c1',
        'u0001',
        Object.assign(new ListCommunityMembersDto(), overrides),
      );
      const listing = issued.find(({ sql }) => sql.includes('ORDER BY'));
      expect(listing).toBeDefined();

      const plan = await rows(`EXPLAIN ${listing!.sql}`, listing!.values);
      const subscriptions = plan.find((row) => row.table === 's');
      expect(subscriptions?.key).toBe(INDEX);
      for (const row of plan) {
        expect((row.Extra as string | null) ?? '').not.toContain(
          'Using filesort',
        );
      }
    },
  );

  it('pages the member listing so each member appears exactly once', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 2; page += 1) {
      const body = await communities.listMembers(
        'c1',
        'u0001',
        Object.assign(new ListCommunityMembersDto(), { page, limit: 60 }),
      );
      expect(body.total).toBe(100);
      seen.push(...body.items.map((item) => item.username));
    }
    expect(seen).toHaveLength(100);
    expect(new Set(seen).size).toBe(100);
    expect(seen).toContain('user_20');
  });
});
