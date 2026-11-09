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
import { AdminCommunitiesService } from '../admin/admin-communities.service';
import { AuditLogService } from '../admin/audit-log.service';
import {
  ListAdminCommunitiesDto,
  type AdminCommunityState,
} from '../admin/dto/admin-communities.dto';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The admin community directory against a real MySQL server: the plans of the
// listing and its state filters, the bounded aggregates, and that hidden
// communities are listed. Seeded with thousands of communities of which few
// are suspended or deleted, as in a real table, so the state indexes are worth
// using. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that
// may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('admin community directory (MySQL)', () => {
  const database = `admin_communities_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let issued: Array<{ sql: string; values: unknown[] }>;
  let directory: AdminCommunitiesService;

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const list = (query: Partial<ListAdminCommunitiesDto>) =>
    directory.findAll(Object.assign(new ListAdminCommunitiesDto(), query));
  const planOf = async (query: Partial<ListAdminCommunitiesDto>) => {
    issued = [];
    await list(query);
    return Promise.all(
      issued.map(async ({ sql, values }) => ({
        sql,
        plan: await rows(`EXPLAIN ${sql}`, values),
      })),
    );
  };

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
      INSERT INTO users (id, username, email, password_hash, role) VALUES
        ('admin', 'admin', 'admin@example.test', 'x', 'admin'),
        ('creator', 'creator', 'creator@example.test', 'x', 'user');`);
    const at = (index: number) =>
      new Date(Date.UTC(2025, 0, 1) + index * 3_600_000);
    await connection.query(
      'INSERT INTO communities (id, creator_id, name, description, created_at) VALUES ?',
      [
        Array.from({ length: 3000 }, (_, index) => [
          `c-${index}`,
          'creator',
          `community-${index}`,
          `Description ${index}`,
          at(index),
        ]),
      ],
    );
    // One in a hundred suspended, one in a hundred deleted.
    await connection.query(`
      UPDATE communities SET suspended_at = UTC_TIMESTAMP(), suspended_by = 'admin'
        WHERE CAST(SUBSTRING(id, 3) AS UNSIGNED) % 100 = 7;
      UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = 'creator'
        WHERE CAST(SUBSTRING(id, 3) AS UNSIGNED) % 100 = 42;`);
    await connection.query(
      'INSERT INTO posts (id, title, content, author_id, community_id) VALUES ?',
      [
        Array.from({ length: 6000 }, (_, index) => [
          `p-${index}`,
          'Title',
          'Body',
          'creator',
          `c-${index % 3000}`,
        ]),
      ],
    );
    await connection.query(
      "INSERT INTO community_subscriptions (user_id, community_id) SELECT 'creator', id FROM communities",
    );
    await connection.query(
      'ANALYZE TABLE communities, posts, community_subscriptions',
    );

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    issued = [];
    directory = new AdminCommunitiesService(
      {
        execute: (sql: string, values: never) => {
          issued.push({ sql, values });
          return pool.execute(sql, values);
        },
        getConnection: () => pool.getConnection(),
      } as unknown as Pool,
      new AuditLogService(pool),
    );
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it.each([
    ['suspended', 'idx_communities_suspended_at'],
    ['deleted', 'idx_communities_deleted_at'],
  ] as const)('reads state=%s through %s', async (state, index) => {
    const [listing] = await planOf({ state });
    expect(listing.plan.find((row) => row.table === 'c')).toMatchObject({
      key: index,
    });
  });

  it.each(['any', 'active'] as AdminCommunityState[])(
    'reads the state=%s listing in idx_communities_created order, never a full scan',
    async (state) => {
      const [listing] = await planOf({ state });
      const communities = listing.plan.find((row) => row.table === 'c')!;
      expect(communities.type).not.toBe('ALL');
      expect(communities.key).toBe('idx_communities_created');
      expect(String(communities.Extra)).not.toContain('filesort');
    },
  );

  it('bounds each aggregate to the page through an index on community_id', async () => {
    const plans = await planOf({ limit: 100 });
    expect(plans).toHaveLength(4);
    for (const { sql, plan } of plans.slice(2)) {
      expect([sql, plan[0].type]).not.toEqual([sql, 'ALL']);
      expect(plan[0].key).not.toBeNull();
    }
  });

  it('lists hidden communities, counts correctly, and pages each once', async () => {
    expect((await list({})).total).toBe(3000);
    expect((await list({ state: 'suspended' })).total).toBe(30);
    expect((await list({ state: 'deleted' })).total).toBe(30);
    expect((await list({ state: 'active' })).total).toBe(2940);

    const { items } = await list({ limit: 100, sort: 'oldest' });
    expect(items[0]).toMatchObject({
      id: 'c-0',
      member_count: 1,
      post_count: 2,
    });

    const seen = new Set<string>();
    for (let page = 1; page <= 30; page += 1) {
      for (const item of (await list({ limit: 100, page })).items) {
        seen.add(item.id);
      }
    }
    expect(seen.size).toBe(3000);
  });
});
