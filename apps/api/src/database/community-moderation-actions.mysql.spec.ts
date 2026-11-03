import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { ListCommunityModerationActionsDto } from '../communities/dto/list-community-moderation-actions.dto';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '021_create_community_moderation_actions';
const LOG_INDEXES = [
  'idx_community_moderation_actions_community',
  'idx_community_moderation_actions_actor',
  'idx_community_moderation_actions_action',
  'idx_community_moderation_actions_target',
];

// The full-install snapshot without its database selection.
const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 021 and 023 undone: the table and both versions.
const preceding = snapshot
  .replace(/CREATE TABLE community_moderation_actions \([\s\S]*?\n\);\r?\n/, '')
  .replace(/,\r?\n\s*\('021_create_community_moderation_actions'\)/, '')
  .replace(/,\r?\n\s*\('023_add_community_moderation_community_actions'\)/, '');

// Runs migration 021 through the real runner on a real MySQL server, over a
// database at version 020, then exercises the cascade rules, the writer's
// transaction semantics, the reader's authorization and the query plans.
// Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may
// create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community moderation actions (MySQL)', () => {
  const database = `moderation_log_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let service: CommunityModerationLogService;
  // Every statement the service sends through the pool.
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

  const query = (overrides: Partial<ListCommunityModerationActionsDto> = {}) =>
    Object.assign(new ListCommunityModerationActionsDto(), overrides);

  const schema = async (name: string) => ({
    indexes: await rows(
      `SELECT index_name AS name,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'community_moderation_actions'
       GROUP BY index_name ORDER BY index_name`,
      [name],
    ),
    foreignKeys: await rows(
      `SELECT k.column_name AS column_name,
              k.referenced_table_name AS referenced, r.delete_rule AS on_delete
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.table_schema
        AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = ? AND k.table_name = 'community_moderation_actions'
       ORDER BY k.column_name`,
      [name],
    ),
    columns: await rows(
      `SELECT column_name AS name, column_type AS type, is_nullable AS nullable
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'community_moderation_actions'
       ORDER BY ordinal_position`,
      [name],
    ),
  });

  beforeAll(async () => {
    expect(preceding).not.toContain('community_moderation_actions');

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

    // c1 is busy enough that a scan is never the cheaper plan: 3000 entries
    // by three moderators over 16 actions, with created_at repeating in
    // pairs so the id tiebreaker decides real orders.
    await connection.query(`
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('creator', 'creator', 'creator@example.test', 'x'),
        ('mod-1', 'mod_one', 'mod1@example.test', 'x'),
        ('mod-2', 'mod_two', 'mod2@example.test', 'x'),
        ('member', 'member', 'member@example.test', 'x'),
        ('admin', 'platform_admin', 'admin@example.test', 'x');
      UPDATE users SET role = 'admin' WHERE id = 'admin';
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c1', 'creator', 'busy'), ('c2', 'creator', 'quiet'),
        ('c3', 'creator', 'doomed');
      INSERT INTO community_subscriptions (user_id, community_id) VALUES
        ('mod-1', 'c1'), ('mod-2', 'c1'), ('member', 'c1'), ('admin', 'c1');
      INSERT INTO community_moderators (community_id, user_id, assigned_by)
        VALUES ('c1', 'mod-1', 'creator'), ('c1', 'mod-2', 'creator');
      INSERT INTO community_moderation_actions
        (id, community_id, actor_id, actor_username, action, target_type,
         target_id, metadata, created_at)
        WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 3000)
        SELECT CONCAT('e', LPAD(n, 4, '0')), 'c1',
               ELT(1 + n % 3, 'creator', 'mod-1', 'mod-2'),
               ELT(1 + n % 3, 'creator', 'mod_one', 'mod_two'),
               ELT(1 + n % 16, 'post_locked', 'post_unlocked', 'post_removed',
                   'post_restored', 'post_pinned', 'post_unpinned',
                   'comment_locked', 'comment_unlocked', 'comment_removed',
                   'comment_restored', 'member_banned', 'member_unbanned',
                   'member_removed', 'moderator_added', 'moderator_removed',
                   'rules_published'),
               'post', CONCAT('gone-post-', n), NULL,
               TIMESTAMP('2026-01-01 00:00:00') + INTERVAL FLOOR(n / 2) MINUTE
        FROM seq;
      INSERT INTO community_moderation_actions
        (id, community_id, actor_id, actor_username, action, target_type, target_id)
        VALUES ('doomed-1', 'c3', 'creator', 'creator', 'post_locked', 'post', 'p');
      ANALYZE TABLE community_moderation_actions;`);

    // Same options as DatabaseModule, so mysql2's default flags apply.
    pool = createPool({ ...credentials, database, connectionLimit: 2 });
    const recording = {
      execute: (sql: string, values: unknown[]) => {
        issued.push({ sql, values });
        return pool.execute(sql, values as never);
      },
      getConnection: () => pool.getConnection(),
    };
    service = new CommunityModerationLogService(recording as unknown as Pool);
  });

  afterAll(async () => {
    await pool?.end();
    await connection?.query(
      `DROP DATABASE IF EXISTS ${database}; DROP DATABASE IF EXISTS ${fresh}`,
    );
    await connection?.end();
  });

  it('applies 021 and 023 once, then skips them', () => {
    expect(firstRun).toEqual([
      `Applied ${VERSION}`,
      'Applied 023_add_community_moderation_community_actions',
    ]);
    expect(secondRun).toEqual([]);
  });

  it('creates the same table as the snapshot, with both foreign keys', async () => {
    const migrated = await schema(database);
    expect(migrated).toEqual(await schema(fresh));
    expect(migrated.foreignKeys).toEqual([
      { column_name: 'actor_id', referenced: 'users', on_delete: 'SET NULL' },
      {
        column_name: 'community_id',
        referenced: 'communities',
        on_delete: 'CASCADE',
      },
    ]);
    expect(migrated.indexes.map(({ name }) => name as string)).toEqual(
      expect.arrayContaining(LOG_INDEXES),
    );
  });

  it('commits an entry with the caller transaction and rolls it back with it', async () => {
    const entry = {
      actorId: 'mod-1',
      communityId: 'c2',
      action: 'post_removed',
      targetType: 'post',
      targetId: 'rolled-back',
      metadata: { reason: 'Spam', body: 'not stored' },
    } as const;
    const tx = await pool.getConnection();
    try {
      await tx.beginTransaction();
      await service.record(tx, entry);
      await tx.rollback();
      await tx.beginTransaction();
      await service.record(tx, { ...entry, targetId: 'committed' });
      await tx.commit();
    } finally {
      tx.release();
    }

    const stored = await rows(
      "SELECT target_id, actor_username, metadata FROM community_moderation_actions WHERE community_id = 'c2'",
    );
    expect(stored).toEqual([
      {
        target_id: 'committed',
        actor_username: 'mod_one',
        metadata: { reason: 'Spam' },
      },
    ]);
  });

  it('writes standalone entries and refuses an unresolvable actor', async () => {
    await service.record({
      actorId: 'creator',
      communityId: 'c2',
      action: 'rules_published',
      targetType: 'rule_document',
      targetId: 'doc-1',
      metadata: { version: 2 },
    });
    await expect(
      service.record({
        actorId: 'nobody',
        communityId: 'c2',
        action: 'post_locked',
        targetType: 'post',
        targetId: 'p',
      }),
    ).rejects.toThrow('could not be resolved');

    expect(
      await rows(
        "SELECT action FROM community_moderation_actions WHERE community_id = 'c2' ORDER BY action",
      ),
    ).toEqual([{ action: 'post_removed' }, { action: 'rules_published' }]);
  });

  it('keeps entries readable after the moderator account is deleted', async () => {
    await connection.query("DELETE FROM users WHERE id = 'mod-2'");

    const [entry] = await rows(
      "SELECT actor_id, actor_username FROM community_moderation_actions WHERE id = 'e0002'",
    );
    expect(entry).toEqual({ actor_id: null, actor_username: 'mod_two' });

    const listed = await service.findAll(
      'busy',
      'creator',
      query({ actor_username: 'mod_two', limit: 100 }),
    );
    expect(listed.total).toBe(1000);
    expect(
      listed.items.every((item) => item.actor_username === 'mod_two'),
    ).toBe(true);
  });

  it('deletes the log of a deleted community', async () => {
    await connection.query("DELETE FROM communities WHERE id = 'c3'");
    expect(
      await rows(
        "SELECT id FROM community_moderation_actions WHERE community_id = 'c3'",
      ),
    ).toEqual([]);
  });

  it('lets only the creator and moderators read, with 404 before 403', async () => {
    await expect(
      service.findAll('busy', 'creator', query()),
    ).resolves.toMatchObject({ total: 3000 });
    await expect(
      service.findAll('busy', 'mod-1', query()),
    ).resolves.toMatchObject({ total: 3000 });
    await expect(
      service.findAll('quiet', 'mod-1', query()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    for (const user of ['member', 'admin']) {
      await expect(
        service.findAll('busy', user, query()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    await expect(
      service.findAll('missing', 'creator', query()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pages a stable order that returns each entry exactly once', async () => {
    for (const sort of ['new', 'oldest'] as const) {
      const seen: string[] = [];
      for (let page = 1; page <= 30; page += 1) {
        const body = await service.findAll(
          'busy',
          'creator',
          query({ sort, page, limit: 100 }),
        );
        seen.push(...body.items.map((item) => item.id));
      }
      expect(seen).toHaveLength(3000);
      expect(new Set(seen).size).toBe(3000);
      expect(seen[0]).toBe(sort === 'new' ? 'e3000' : 'e0001');
    }
  });

  it.each([
    [{}, 'idx_community_moderation_actions_community'],
    [{ sort: 'oldest' as const }, 'idx_community_moderation_actions_community'],
    [{ actor_username: 'mod_one' }, null],
    [{ action: 'member_banned' as const }, null],
    [{ target_type: 'post' as const }, null],
    [
      { from: '2026-01-01T10:00:00Z', to: '2026-01-01T20:00:00Z' },
      'idx_community_moderation_actions_community',
    ],
  ])('plans the listing for %o on a log index', async (filters, expected) => {
    issued.length = 0;
    await service.findAll('busy', 'creator', query(filters));
    const listing = issued.find(({ sql }) => sql.includes('ORDER BY'));
    expect(listing).toBeDefined();

    const [plan] = await rows(`EXPLAIN ${listing!.sql}`, listing!.values);
    expect(LOG_INDEXES).toContain(plan.key);
    if (expected) {
      expect(plan.key).toBe(expected);
    }
  });
});
