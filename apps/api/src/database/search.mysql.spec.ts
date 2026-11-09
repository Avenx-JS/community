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
import {
  SearchQueryDto,
  type SearchType,
} from '../search/dto/search-query.dto';
import { SearchService } from '../search/search.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// GET /search against a real MySQL server: the plan of each type, real
// boolean-mode behaviour of the sanitised terms, and the exclusions. Seeded
// with thousands of rows of varied vocabulary, so a scan is the expensive
// choice. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials
// that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

const VOCABULARY = [
  'kitten',
  'puppy',
  'garden',
  'recipe',
  'bicycle',
  'harbour',
  'violin',
  'glacier',
  'lantern',
  'meadow',
  'orchard',
  'pebble',
  'quartz',
  'saddle',
  'thimble',
  'umbrella',
  'velvet',
  'walnut',
  'yonder',
  'zephyr',
];

integration('search (MySQL)', () => {
  const database = `search_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let issued: Array<{ sql: string; values: unknown[] }>;
  let search: SearchService;

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const run = (query: Partial<SearchQueryDto>) =>
    search.search(Object.assign(new SearchQueryDto(), query));
  const words = (seed: number, count: number) =>
    Array.from(
      { length: count },
      (_, index) => VOCABULARY[(seed * 7 + index * 3) % VOCABULARY.length],
    ).join(' ');

  beforeAll(async () => {
    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${snapshot}`,
    );
    const at = (index: number) =>
      new Date(Date.UTC(2026, 0, 1) + index * 60_000);
    const users = Array.from({ length: 1500 }, (_, index) => [
      `u-${index}`,
      `member_${String(index).padStart(4, '0')}`,
      `member${index}@example.test`,
      'x',
      at(index),
    ]);
    users.push(['u-alice', 'alice', 'alice.private@example.test', 'x', at(0)]);
    users.push([
      'u-gone',
      'deleted_u-gone',
      'deleted_u-gone@invalid',
      'x',
      at(0),
    ]);
    await connection.query(
      'INSERT INTO users (id, username, email, password_hash, created_at) VALUES ?',
      [users],
    );
    await connection.query(
      "UPDATE users SET deleted_at = UTC_TIMESTAMP() WHERE id = 'u-gone'",
    );
    await connection.query(
      'INSERT INTO communities (id, creator_id, name, description, created_at) VALUES ?',
      [
        Array.from({ length: 400 }, (_, index) => [
          `c-${index}`,
          'u-alice',
          `community-${index}`,
          words(index, 6),
          at(index),
        ]),
      ],
    );
    await connection.query(`
      INSERT INTO communities (id, creator_id, name, description) VALUES
        ('c-gone', 'u-alice', 'gone', 'mockingbird deleted'),
        ('c-susp', 'u-alice', 'susp', 'mockingbird suspended');
      UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = 'u-alice' WHERE id = 'c-gone';
      UPDATE communities SET suspended_at = UTC_TIMESTAMP() WHERE id = 'c-susp';`);
    await connection.query(
      'INSERT INTO posts (id, title, content, author_id, community_id, created_at) VALUES ?',
      [
        Array.from({ length: 4000 }, (_, index) => [
          `p-${index}`,
          words(index, 3),
          words(index + 1, 12),
          `u-${index % 1500}`,
          `c-${index % 400}`,
          at(index),
        ]),
      ],
    );
    await connection.query(
      'INSERT INTO comments (id, post_id, author_id, content, created_at) VALUES ?',
      [
        Array.from({ length: 4000 }, (_, index) => [
          `m-${index}`,
          `p-${index % 4000}`,
          `u-${index % 1500}`,
          words(index + 2, 10),
          at(index),
        ]),
      ],
    );
    // A rare word, hidden everywhere it must stay hidden, visible once.
    await connection.query(`
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-visible', 'mockingbird', 'visible', 'u-alice', 'c-0'),
        ('p-removed', 'mockingbird', 'removed', 'u-alice', 'c-0'),
        ('p-gone', 'mockingbird', 'deleted community', 'u-alice', 'c-gone'),
        ('p-susp', 'mockingbird', 'suspended community', 'u-alice', 'c-susp');
      UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'u-alice' WHERE id = 'p-removed';
      INSERT INTO comments (id, post_id, author_id, content) VALUES
        ('m-visible', 'p-visible', 'u-alice', 'mockingbird visible'),
        ('m-removed', 'p-visible', 'u-alice', 'mockingbird removed'),
        ('m-on-removed', 'p-removed', 'u-alice', 'mockingbird on removed'),
        ('m-gone', 'p-gone', 'u-alice', 'mockingbird deleted'),
        ('m-susp', 'p-susp', 'u-alice', 'mockingbird suspended');
      UPDATE comments SET removed_at = UTC_TIMESTAMP(), removed_by = 'u-alice' WHERE id = 'm-removed';
      ANALYZE TABLE users, communities, posts, comments;`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    issued = [];
    search = new SearchService({
      execute: (sql: string, values: never) => {
        issued.push({ sql, values });
        return pool.execute(sql, values);
      },
    } as unknown as Pool);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  const planOf = async (query: Partial<SearchQueryDto>) => {
    issued = [];
    await run(query);
    const listing = issued.find(({ sql }) => sql.includes('LIMIT ? OFFSET ?'))!;
    return rows(`EXPLAIN ${listing.sql}`, listing.values);
  };

  it.each([
    ['posts', 'posts', 'ft_posts_title_content'],
    ['comments', 'c', 'ft_comments_content'],
    ['communities', 'communities', 'ft_communities_name_description'],
  ] as const)(
    'reads type=%s through its FULLTEXT index',
    async (type, table, index) => {
      for (const sort of ['relevance', 'new'] as const) {
        const plan = await planOf({ q: 'glacier', type, sort });
        expect(plan.find((row) => row.table === table)).toMatchObject({
          type: 'fulltext',
          key: index,
        });
        for (const row of plan) {
          expect([row.table, row.type]).not.toEqual([row.table, 'ALL']);
        }
      }
    },
  );

  it('reads type=users as a range on the username index, with no scan', async () => {
    const plan = await planOf({ q: 'member_01', type: 'users' });
    expect(plan[0]).toMatchObject({ type: 'range', key: 'username' });
  });

  it('pages each row exactly once and counts what it lists', async () => {
    for (const sort of ['relevance', 'new'] as const) {
      const first = await run({
        q: 'glacier',
        type: 'posts',
        sort,
        limit: 100,
      });
      expect(first.total).toBeGreaterThan(200);
      const seen = new Set<string>();
      const pages = Math.ceil(first.total / 100);
      for (let page = 1; page <= pages; page += 1) {
        const { items } = await run({
          q: 'glacier',
          type: 'posts',
          sort,
          limit: 100,
          page,
        });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
          seen.add((item as { id: string }).id);
        }
      }
      expect(seen.size).toBe(first.total);
    }
  });

  it.each(['+', '-', '>', '<', '(', ')', '~', '*', '"', '@'])(
    'runs a query full of %s as plain words on a real server',
    async (operator) => {
      const q = `${operator}glacier ${operator.repeat(3)}mock${operator}ingbird${operator} ${operator}8`;
      for (const type of ['posts', 'comments', 'communities'] as SearchType[]) {
        await expect(run({ q, type })).resolves.toMatchObject({ type });
      }
      // "+glacier -walnut" would require one and exclude the other; as plain
      // words it matches either.
      const plain = await run({ q: 'glacier walnut', type: 'posts' });
      const operators = await run({ q: '+glacier -walnut', type: 'posts' });
      expect(operators.total).toBe(plain.total);
    },
  );

  it('never lists removed or hidden-community rows', async () => {
    const ids = async (type: SearchType) =>
      (await run({ q: 'mockingbird', type, limit: 100 })).items.map(
        (item) => (item as { id: string }).id,
      );
    expect(await ids('posts')).toEqual(['p-visible']);
    expect(await ids('comments')).toEqual(['m-visible']);
    expect(await ids('communities')).toEqual([]);
  });

  it('finds no account by email, and none that was deleted', async () => {
    for (const q of [
      'alice.private@example.test',
      'member0@example',
      'deleted_u',
    ]) {
      expect((await run({ q, type: 'users' })).total).toBe(0);
    }
    expect((await run({ q: 'ali', type: 'users' })).items).toEqual([
      expect.objectContaining({ username: 'alice' }),
    ]);
  });
});
