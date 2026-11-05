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
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { PostsService } from '../posts/posts.service';
import type { NotificationsService } from '../notifications/notifications.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '022_add_community_deletion';

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 022 undone: the communities columns, constraints, index
// and version. users.deleted_at (migration 020) is not followed by
// deleted_by, so it is untouched.
const preceding = snapshot
  .replace(
    / {4}deleted_at TIMESTAMP NULL DEFAULT NULL,\r?\n {4}deleted_by VARCHAR\(36\) NULL,\r?\n/,
    '',
  )
  .replace(/ {4}CONSTRAINT fk_communities_deleted_by[^\n]*\n/, '')
  .replace(/ {4}CONSTRAINT chk_communities_deletion[^\n]*\n/, '')
  .replace(/CREATE INDEX idx_communities_deleted_at[^\n]*\n/, '')
  .replace(/,\r?\n\s*\('022_add_community_deletion'\)/, '');

// Runs migration 022 through the real runner on a real MySQL server, over a
// database at version 021, then soft-deletes a community through the real
// service. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials
// that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community deletion (MySQL)', () => {
  const database = `community_deletion_${randomBytes(4).toString('hex')}`;
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
  let posts: PostsService;
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

  const schema = async (name: string) => ({
    columns: await rows(
      `SELECT column_name AS name, column_type AS type, is_nullable AS nullable
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'communities'
       ORDER BY column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'communities'
       GROUP BY index_name ORDER BY index_name`,
      [name],
    ),
    constraints: await rows(
      `SELECT constraint_name AS name, constraint_type AS type
       FROM information_schema.table_constraints
       WHERE table_schema = ? AND table_name = 'communities'
       ORDER BY constraint_name`,
      [name],
    ),
    foreignKeys: await rows(
      `SELECT k.column_name AS column_name, r.delete_rule AS on_delete
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.table_schema
        AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = ? AND k.table_name = 'communities'
       ORDER BY k.column_name`,
      [name],
    ),
  });

  beforeAll(async () => {
    expect(preceding).not.toContain('deleted_by');
    expect(preceding).toContain('CREATE INDEX idx_users_deleted_at');

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
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('creator', 'creator', 'creator@example.test', 'x'),
        ('member', 'member', 'member@example.test', 'x'),
        ('operator', 'operator', 'operator@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c1', 'creator', 'gardening'), ('c2', 'creator', 'cooking');`);
    firstRun = await migrate();
    secondRun = await migrate();

    await connection.query(`
      INSERT INTO community_subscriptions (user_id, community_id)
        VALUES ('member', 'c1');
      INSERT INTO community_moderators (community_id, user_id, assigned_by)
        VALUES ('c1', 'member', 'creator');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p1', 'Tomatoes', 'Ready', 'member', 'c1'),
        ('p2', 'Soup', 'Hot', 'member', 'c2');
      INSERT INTO comments (id, post_id, author_id, content)
        VALUES ('m1', 'p1', 'creator', 'Lovely');`);

    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    const ruleAcceptance = {
      assertAcceptedOrThrow: () => Promise.resolve(),
    } as unknown as CommunityRuleAcceptanceService;
    communities = new CommunitiesService(
      pool,
      ruleAcceptance,
      new CommunityModerationLogService(pool),
    );
    posts = new PostsService(
      pool,
      {} as NotificationsService,
      ruleAcceptance,
      new CommunityModerationLogService(pool),
    );
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  it('applies 022 once, then skips it, leaving existing communities live', async () => {
    expect(firstRun).toEqual([`Applied ${VERSION}`]);
    expect(secondRun).toEqual([]);
    expect(
      await rows('SELECT id FROM communities WHERE deleted_at IS NOT NULL'),
    ).toEqual([]);
  });

  it('matches the snapshot, with the foreign key, check and index', async () => {
    const migrated = await schema(database);
    expect(migrated).toEqual(await schema(fresh));
    expect(migrated.constraints).toEqual(
      expect.arrayContaining([
        { name: 'fk_communities_deleted_by', type: 'FOREIGN KEY' },
        { name: 'chk_communities_deletion', type: 'CHECK' },
      ]),
    );
    expect(migrated.foreignKeys).toEqual(
      expect.arrayContaining([
        { column_name: 'deleted_by', on_delete: 'SET NULL' },
      ]),
    );
    expect(migrated.indexes).toEqual(
      expect.arrayContaining([
        { name: 'idx_communities_deleted_at', columns: 'deleted_at' },
      ]),
    );
  });

  it('refuses an actor without a timestamp', async () => {
    await expect(
      connection.query(
        "UPDATE communities SET deleted_by = 'creator' WHERE id = 'c2'",
      ),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  });

  it('soft-deletes, logs, hides the community and destroys nothing', async () => {
    const counts = () =>
      rows(`SELECT
        (SELECT COUNT(*) FROM posts) AS posts,
        (SELECT COUNT(*) FROM comments) AS comments,
        (SELECT COUNT(*) FROM community_subscriptions) AS subscriptions,
        (SELECT COUNT(*) FROM community_moderators) AS moderators`);
    const before = await counts();

    await communities.remove('gardening', 'gardening', 'creator');

    expect(await counts()).toEqual(before);
    const [deleted] = await rows(
      "SELECT deleted_at, deleted_by FROM communities WHERE id = 'c1'",
    );
    expect(deleted.deleted_at).toBeInstanceOf(Date);
    expect(deleted.deleted_by).toBe('creator');
    expect(
      await rows(
        "SELECT action, target_type, target_id FROM community_moderation_actions WHERE community_id = 'c1'",
      ),
    ).toEqual([
      {
        action: 'community_deleted',
        target_type: 'community',
        target_id: 'c1',
      },
    ]);

    await expect(communities.findOne('gardening')).rejects.toThrow(
      'Community not found',
    );
    expect((await communities.findAll({})).items.map(({ id }) => id)).toEqual([
      'c2',
    ]);
    await expect(posts.findOne('p1')).rejects.toThrow('Post not found');
    expect((await posts.findAll({})).items.map(({ id }) => id)).toEqual(['p2']);
    await expect(
      communities.remove('gardening', 'gardening', 'creator'),
    ).rejects.toThrow('Community not found');
  });

  it('keeps deleted_at when the acting account is removed', async () => {
    // Only the creator can delete through the API, and removing the creator
    // cascades the community away. An operator-recorded deletion shows the
    // ON DELETE SET NULL behaviour the column is declared with.
    await connection.query(
      "UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = 'operator' WHERE id = 'c2'",
    );
    await connection.query("DELETE FROM users WHERE id = 'operator'");

    const [row] = await rows(
      "SELECT deleted_at, deleted_by FROM communities WHERE id = 'c2'",
    );
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(row.deleted_by).toBeNull();
  });
});
