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
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';

const migrations = resolve(__dirname, '../../../../data/migrations');

// The full-install snapshot without its database selection, so it loads into
// a scratch database.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 015 undone: its FULLTEXT statements and the 015 version
// removed, so the runner applies 015 alone. Building it this way, rather than dropping the indexes, keeps the
// tables free of the hidden FTS_DOC_ID column, so 015 performs the same
// rebuild it performs on an upgraded installation.
const preceding = snapshot
  .replace(/^CREATE FULLTEXT INDEX[^;]*;\r?\n/gm, '')
  .replace(/,\r?\n\s*\('015_add_fulltext_search_indexes'\)/, '');

const POSTS_MATCH =
  'SELECT id FROM posts WHERE MATCH (title, content) AGAINST (? IN BOOLEAN MODE) ORDER BY id';
const COMMENTS_MATCH =
  'SELECT id FROM comments WHERE MATCH (content) AGAINST (? IN BOOLEAN MODE) ORDER BY id';
const COMMUNITIES_MATCH =
  'SELECT id FROM communities WHERE MATCH (name, description) AGAINST (? IN BOOLEAN MODE) ORDER BY id';

interface IndexColumnRow extends RowDataPacket {
  table_name: string;
  index_name: string;
  column_name: string;
  seq_in_index: number;
}

// Runs migration 015 through the real runner on a real MySQL server, over a
// seeded database at version 014. Opt in with MYSQL_INTEGRATION_TEST=true and
// MYSQL_* credentials that may create and drop scratch databases; skipped
// otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('full-text search indexes (MySQL)', () => {
  const database = `fulltext_${randomBytes(4).toString('hex')}`;
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
  const searchesBefore = new Map<string, unknown>();
  const searchTerms = ['community', 'art', 'Gardening', '50%'];

  const migrator = (): MigrationConnection => ({
    execute: async (sql, values) => {
      const [result, fields] = await connection.execute(sql, values);
      return [result, fields];
    },
    query: async (sql) => {
      const [result, fields] = await connection.query(sql);
      return [result, fields];
    },
    end: () => Promise.resolve(),
  });

  const migrate = async () => {
    const log: string[] = [];
    await runMigrations(migrator(), await loadMigrations(migrations), (line) =>
      log.push(line),
    );
    return log;
  };

  const ids = async (sql: string, term: string) => {
    const [rows] = await connection.query<RowDataPacket[]>(sql, [term]);
    return rows.map((row) => row.id as string);
  };

  const fulltextColumns = async (schema: string) => {
    const [rows] = await connection.query<IndexColumnRow[]>(
      `SELECT table_name AS table_name, index_name AS index_name,
              column_name AS column_name, seq_in_index AS seq_in_index
       FROM information_schema.statistics
       WHERE table_schema = ? AND index_type = 'FULLTEXT'
       ORDER BY table_name, index_name, seq_in_index`,
      [schema],
    );
    return rows.map((row) => ({
      ...row,
      seq_in_index: Number(row.seq_in_index),
    }));
  };

  beforeAll(async () => {
    expect(preceding).not.toMatch(/FULLTEXT|015_add_fulltext_search_indexes/);

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

    // Every post, comment and community contains "community", so it is the
    // very common word. "go" is below the minimum token length, "the" is a
    // built-in stopword, and "start" must not match a search for "art".
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('u1', 'alice', 'alice@example.test', 'x');
      INSERT INTO communities (id, creator_id, name, description, created_at)
        VALUES
        ('c1', 'u1', 'gardening', 'A community for the garden', '2026-01-01 00:00:00'),
        ('c2', 'u1', 'art', 'An art community', '2026-01-02 00:00:00'),
        ('c3', 'u1', 'startups', 'Where every community member can start', '2026-01-02 00:00:00'),
        ('c4', 'u1', 'discounts', 'Community deals of 50% off', '2026-01-03 00:00:00');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p1', 'Community art show', 'Bring your art', 'u1', 'c2'),
        ('p2', 'How to start', 'A community guide to go further', 'u1', 'c3'),
        ('p3', 'Community garden', 'The tomatoes are ready', 'u1', 'c1');
      INSERT INTO comments (id, post_id, author_id, content) VALUES
        ('m1', 'p1', 'u1', 'Lovely community art'),
        ('m2', 'p2', 'u1', 'Great community start, go on'),
        ('m3', 'p3', 'u1', 'The community thanks you');`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    // findAll does not consult rule acceptance.
    communities = new CommunitiesService(
      pool,
      {} as CommunityRuleAcceptanceService,
    );
    for (const search of searchTerms) {
      searchesBefore.set(search, await communities.findAll({ search }));
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  it('applies 015 to a database at 014 once, and skips it on a second run', async () => {
    const first = await migrate();
    expect(first.filter((line) => line.startsWith('Applied'))).toEqual([
      'Applied 015_add_fulltext_search_indexes',
    ]);

    const second = await migrate();
    expect(second.filter((line) => !line.startsWith('Skipped'))).toEqual([]);
    expect(second).toContain(
      'Skipped 015_add_fulltext_search_indexes (already applied)',
    );

    const [recorded] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '015_add_fulltext_search_indexes'",
    );
    expect(Number(recorded[0].n)).toBe(1);
  }, 60_000);

  it('reports FULLTEXT indexes with the expected columns in order, as the snapshot does', async () => {
    const expected = [
      ['comments', 'ft_comments_content', 'content', 1],
      ['communities', 'ft_communities_name_description', 'name', 1],
      ['communities', 'ft_communities_name_description', 'description', 2],
      ['posts', 'ft_posts_title_content', 'title', 1],
      ['posts', 'ft_posts_title_content', 'content', 2],
    ].map(([table_name, index_name, column_name, seq_in_index]) => ({
      table_name,
      index_name,
      column_name,
      seq_in_index,
    }));

    await expect(fulltextColumns(database)).resolves.toEqual(expected);
    await expect(fulltextColumns(fresh)).resolves.toEqual(expected);
  });

  it.each([
    ['posts', POSTS_MATCH, 'ft_posts_title_content'],
    ['comments', COMMENTS_MATCH, 'ft_comments_content'],
    ['communities', COMMUNITIES_MATCH, 'ft_communities_name_description'],
  ])(
    'plans a boolean-mode MATCH on %s as a fulltext access, not a scan',
    async (_table, sql, index) => {
      const [plan] = await connection.query<RowDataPacket[]>(`EXPLAIN ${sql}`, [
        'community',
      ]);
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({ type: 'fulltext', key: index });
    },
  );

  it('matches whole words, not substrings', async () => {
    await expect(ids(POSTS_MATCH, 'art')).resolves.toEqual(['p1']);
    await expect(ids(COMMENTS_MATCH, 'art')).resolves.toEqual(['m1']);
    await expect(ids(COMMUNITIES_MATCH, 'art')).resolves.toEqual(['c2']);
  });

  it('matches nothing for terms shorter than innodb_ft_min_token_size', async () => {
    const [settings] = await connection.query<RowDataPacket[]>(
      'SELECT @@innodb_ft_min_token_size AS min_token_size',
    );
    expect(Number(settings[0].min_token_size)).toBe(3);

    // "go" appears verbatim in p2 and m2.
    await expect(ids(POSTS_MATCH, 'go')).resolves.toEqual([]);
    await expect(ids(COMMENTS_MATCH, 'go')).resolves.toEqual([]);
  });

  it('matches nothing for a built-in stopword', async () => {
    await expect(ids(POSTS_MATCH, 'the')).resolves.toEqual([]);
    await expect(ids(COMMENTS_MATCH, 'the')).resolves.toEqual([]);
  });

  it('returns a word present in every row in boolean mode, unlike natural-language mode', async () => {
    await expect(ids(POSTS_MATCH, 'community')).resolves.toEqual([
      'p1',
      'p2',
      'p3',
    ]);
    await expect(ids(COMMENTS_MATCH, 'community')).resolves.toEqual([
      'm1',
      'm2',
      'm3',
    ]);
    await expect(ids(COMMUNITIES_MATCH, 'community')).resolves.toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
    ]);

    // The failure boolean mode avoids: a word in every row has zero inverse
    // document frequency, so natural-language mode drops every row.
    await expect(
      ids(
        'SELECT id FROM posts WHERE MATCH (title, content) AGAINST (? IN NATURAL LANGUAGE MODE)',
        'community',
      ),
    ).resolves.toEqual([]);
  });

  it('makes newly inserted rows matchable immediately', async () => {
    await connection.query(`
      INSERT INTO communities (id, creator_id, name, description)
        VALUES ('c5', 'u1', 'zephyrine', 'Fresh community');
      INSERT INTO posts (id, title, content, author_id, community_id)
        VALUES ('p4', 'Zephyrine winds', 'Fresh post', 'u1', 'c5');
      INSERT INTO comments (id, post_id, author_id, content)
        VALUES ('m4', 'p4', 'u1', 'Zephyrine indeed');`);

    await expect(ids(POSTS_MATCH, 'zephyrine')).resolves.toEqual(['p4']);
    await expect(ids(COMMENTS_MATCH, 'zephyrine')).resolves.toEqual(['m4']);
    await expect(ids(COMMUNITIES_MATCH, 'zephyrine')).resolves.toEqual(['c5']);

    // Cascades to p4 and m4, restoring the rows the search comparison saw.
    await connection.query("DELETE FROM communities WHERE id = 'c5'");
  });

  it('leaves GET /communities?search= results and ordering unchanged', async () => {
    for (const search of searchTerms) {
      await expect(communities.findAll({ search })).resolves.toEqual(
        searchesBefore.get(search),
      );
    }
  });
});
