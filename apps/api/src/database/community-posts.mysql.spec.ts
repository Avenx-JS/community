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
import type { NotificationsService } from '../notifications/notifications.service';
import { CommunityPostsController } from '../posts/community-posts.controller';
import { PostsService } from '../posts/posts.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// GET /communities/:name/posts against a real MySQL server: identical to
// GET /posts?community_id= for the same community (pins first included),
// its exclusions and 404s, paging, and the plan. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and
// drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community posts listing (MySQL)', () => {
  const database = `community_posts_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let posts: PostsService;
  let controller: CommunityPostsController;
  // Every statement the services send through the pool.
  const issued: { sql: string; values: unknown[] }[] = [];

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };
  const byName = (name: string, query = {}) => controller.findAll(name, query);
  const byId = (id: string, query = {}) =>
    posts.findAll({ ...query, community_id: id });

  beforeAll(async () => {
    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${snapshot}`,
    );
    // c1 holds 200 of 4000 posts, created_at repeating in pairs so the id
    // tiebreaker decides real orders; three are pinned and two removed.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50)
        SELECT CONCAT('u', n), CONCAT('u', n), CONCAT('u', n, '@example.test'), 'x'
        FROM seq;
      INSERT INTO communities (id, creator_id, name)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20)
        SELECT CONCAT('c', n), 'u1', CONCAT('name', n) FROM seq;
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c-empty', 'u1', 'empty'), ('c-deleted', 'u1', 'deleted'),
        ('c-suspended', 'u1', 'suspended');
      UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = 'u1'
        WHERE id = 'c-deleted';
      UPDATE communities SET suspended_at = UTC_TIMESTAMP() WHERE id = 'c-suspended';
      INSERT INTO posts (id, title, content, author_id, community_id, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 4000)
        SELECT CONCAT('p', n), CONCAT('Post ', n), 'Body',
               CONCAT('u', 1 + n % 50), CONCAT('c', 1 + n % 20),
               TIMESTAMP('2026-01-01 00:00:00') + INTERVAL FLOOR(n / 2) MINUTE
        FROM seq;
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-deleted', 'In deleted', 'Body', 'u1', 'c-deleted'),
        ('p-suspended', 'In suspended', 'Body', 'u1', 'c-suspended');
      UPDATE posts SET pinned_at = '2026-06-01 00:00:00', pinned_by = 'u1' WHERE id = 'p20';
      UPDATE posts SET pinned_at = '2026-06-02 00:00:00', pinned_by = 'u1' WHERE id = 'p40';
      UPDATE posts SET pinned_at = '2026-06-03 00:00:00', pinned_by = NULL WHERE id = 'p60';
      UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'u1'
        WHERE id IN ('p80', 'p100');
      ANALYZE TABLE posts, communities;`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    const recording = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === 'execute') {
          return (sql: string, values: (string | number)[] = []) => {
            issued.push({ sql, values });
            return target.execute(sql, values);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    posts = new PostsService(
      recording,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
      {} as CommunityModerationLogService,
    );
    controller = new CommunityPostsController(
      new CommunitiesService(
        recording,
        {} as CommunityRuleAcceptanceService,
        {} as CommunityModerationLogService,
      ),
      posts,
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it.each([
    {},
    { page: 2, limit: 20 },
    { page: 1, limit: 2 },
    { page: 10, limit: 20 },
    { page: 11, limit: 20 },
  ])(
    'returns exactly what GET /posts?community_id= returns, for %o',
    async (query) => {
      const named = await byName('name1', query);
      expect(named).toEqual(await byId('c1', query));
      expect(named.total).toBe(198);
    },
  );

  it('lists pins first, most recently pinned first, on both routes alike', async () => {
    const named = await byName('name1', { limit: 5 });
    expect(named.items.map((post) => post.id).slice(0, 3)).toEqual([
      'p60',
      'p40',
      'p20',
    ]);
    // A pin whose moderator is gone renders pinned_by null.
    expect(named.items[0]).toMatchObject({ pinned_by: null });
    expect(named).toEqual(await byId('c1', { limit: 5 }));
  });

  it('pages every visible post exactly once with the id tiebreaker', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const result = await byName('name1', { page, limit: 20 });
      seen.push(...result.items.map((post) => post.id));
    }
    expect(seen).toHaveLength(198);
    expect(new Set(seen).size).toBe(198);
    expect(seen).not.toContain('p80');
    expect(seen).not.toContain('p100');

    const unpinned = await rows(
      "SELECT id FROM posts WHERE community_id = 'c1' AND pinned_at IS NULL AND removed_at IS NULL ORDER BY created_at DESC, id DESC",
    );
    expect(seen.slice(3)).toEqual(unpinned.map((row) => String(row.id)));
  });

  it('omits posts removed by moderation from the shared listing', async () => {
    const all = await byId('c1', { limit: 100, page: 1 });
    const second = await byId('c1', { limit: 100, page: 2 });
    const ids = [...all.items, ...second.items].map((post) => post.id);
    expect(ids).not.toContain('p80');
    expect(ids).not.toContain('p100');
  });

  it('answers an empty community with an empty page', async () => {
    await expect(byName('empty')).resolves.toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      sort: 'new',
    });
  });

  it.each(['deleted', 'suspended', 'no_such_community'])(
    'answers %s with 404, not an empty list',
    async (name) => {
      issued.length = 0;
      await expect(byName(name)).rejects.toMatchObject({ status: 404 });
      // Only the name lookup ran: no listing for a hidden community.
      expect(issued).toHaveLength(1);
    },
  );

  // Measured on MySQL 8.0.46. The community filter is a ref lookup on
  // idx_posts_community_created, but since pinning (#60) the leading
  // (pinned_at IS NULL) term needs a filesort over the community's rows: the
  // trade-off the pinning section of the README records, here as on the
  // filtered GET /posts, because both run the same query. MySQL reports it
  // on the const communities row of the deleted-community semi-join.
  it("plans the listing as a ref on the community's index, with the pinning filesort", async () => {
    issued.length = 0;
    await byName('name1', { page: 2, limit: 20 });
    const listing = issued.find(({ sql }) => sql.includes('ORDER BY'));
    expect(listing).toBeDefined();

    const plan = await rows(`EXPLAIN ${listing!.sql}`, listing!.values);
    const postsRow = plan.find((row) => row.table === 'posts');
    expect(postsRow).toMatchObject({
      type: 'ref',
      key: 'idx_posts_community_created',
    });
    for (const row of plan) {
      expect(row.type).not.toBe('ALL');
    }
    expect(
      plan.some((row) => String(row.Extra).includes('Using filesort')),
    ).toBe(true);
  });
});
