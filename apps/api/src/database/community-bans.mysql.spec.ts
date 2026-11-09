import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
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
import { ACTIVE_COMMUNITY_BAN_SQL } from '../common/active-community-ban';
import { CommunityBansService } from '../communities/community-bans.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { ListCommunityBansDto } from '../communities/dto/community-ban.dto';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Community bans against a real MySQL server: the table and its trigger, the
// plan of the active-ban lookup that enforcement will run on every
// participation attempt, real lock contention between two bans, and the scope
// isolation from platform restrictions. Opt in with MYSQL_INTEGRATION_TEST=true
// and MYSQL_* credentials that may create and drop scratch databases; skipped
// otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community bans (MySQL)', () => {
  const database = `community_bans_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let bans: CommunityBansService;

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const count = async (sql: string, values: unknown[] = []) =>
    Number((await rows(sql, values))[0].total);

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
        ('creator', 'creator', 'creator@example.test', 'x', 'user'),
        ('moderator', 'a_moderator', 'moderator@example.test', 'x', 'user'),
        ('member', 'member', 'member@example.test', 'x', 'user'),
        ('admin', 'platform_admin', 'admin@example.test', 'x', 'admin');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c-a', 'creator', 'a-community'),
        ('c-b', 'creator', 'b-community');
      INSERT INTO community_moderators (community_id, user_id, assigned_by)
        VALUES ('c-a', 'moderator', 'creator');
      INSERT INTO community_subscriptions (user_id, community_id) VALUES
        ('member', 'c-a'), ('member', 'c-b'), ('admin', 'c-a'), ('moderator', 'c-a');`);

    pool = createPool({ ...credentials, database, connectionLimit: 8 });
    bans = new CommunityBansService(
      pool,
      new CommunityModerationLogService(pool),
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  it('creates the table with its indexes and foreign keys', async () => {
    const indexes = (
      await rows(
        `SELECT DISTINCT index_name FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = 'community_bans'`,
        [database],
      )
    ).map((row) => String(row.INDEX_NAME ?? row.index_name));
    expect(indexes.sort()).toEqual(
      [
        'PRIMARY',
        'fk_community_bans_created_by',
        'fk_community_bans_lifted_by',
        'idx_community_bans_active',
        'idx_community_bans_community_created',
        'idx_community_bans_user',
      ].sort(),
    );
    const keys = await rows(
      `SELECT constraint_name, delete_rule FROM information_schema.referential_constraints
       WHERE constraint_schema = ? AND table_name = 'community_bans'`,
      [database],
    );
    expect(
      Object.fromEntries(
        keys.map((row) => [
          String(row.CONSTRAINT_NAME ?? row.constraint_name),
          String(row.DELETE_RULE ?? row.delete_rule),
        ]),
      ),
    ).toEqual({
      fk_community_bans_community: 'CASCADE',
      fk_community_bans_user: 'CASCADE',
      fk_community_bans_created_by: 'SET NULL',
      fk_community_bans_lifted_by: 'SET NULL',
    });
  });

  it('refuses a lifter without a lift time with the CHECK error', async () => {
    await expect(
      connection.query(
        `INSERT INTO community_bans (id, community_id, user_id, reason, lifted_by)
         VALUES ('bad', 'c-a', 'member', 'x', 'creator')`,
      ),
    ).rejects.toMatchObject({ errno: 3819 });
  });

  it('serves the active-ban lookup from idx_community_bans_active', async () => {
    await connection.query(
      `INSERT INTO community_bans (id, community_id, user_id, reason, created_at)
       SELECT CONCAT('seed-', seq), IF(seq % 2 = 0, 'c-a', 'c-b'), 'creator', 'seed',
              UTC_TIMESTAMP() - INTERVAL seq MINUTE
       FROM (
         WITH RECURSIVE n (seq) AS (SELECT 1 UNION ALL SELECT seq + 1 FROM n WHERE seq < 500)
         SELECT seq FROM n
       ) numbers`,
    );
    await connection.query(
      "UPDATE community_bans SET lifted_at = UTC_TIMESTAMP() WHERE id LIKE 'seed-%'",
    );
    await connection.query('ANALYZE TABLE community_bans');
    const plan = await rows(`EXPLAIN ${ACTIVE_COMMUNITY_BAN_SQL}`, [
      'c-a',
      'member',
    ]);
    expect(plan[0]).toMatchObject({ key: 'idx_community_bans_active' });
    expect(plan[0].type).not.toBe('ALL');
  });

  it('yields exactly one ban for two concurrent bans of one account', async () => {
    const results = await Promise.allSettled([
      bans.ban('a-community', { username: 'member', reason: 'A' }, 'moderator'),
      bans.ban('a-community', { username: 'member', reason: 'B' }, 'creator'),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )!;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM community_bans WHERE user_id = 'member' AND community_id = 'c-a'",
      ),
    ).toBe(1);
  });

  // The distinction the feature exists to preserve.
  it('ends membership in one community only, and creates no platform restriction', async () => {
    expect(await count('SELECT COUNT(*) AS total FROM user_restrictions')).toBe(
      0,
    );
    expect(
      await rows(
        "SELECT community_id FROM community_subscriptions WHERE user_id = 'member'",
      ),
    ).toEqual([{ community_id: 'c-b' }]);
    expect(await rows(ACTIVE_COMMUNITY_BAN_SQL, ['c-b', 'member'])).toEqual([]);
    expect(
      (await rows(ACTIVE_COMMUNITY_BAN_SQL, ['c-a', 'member'])).length,
    ).toBe(1);
  });

  it('bans a platform administrator, and reads an expired ban as inactive', async () => {
    const ban = await bans.ban(
      'a-community',
      { username: 'platform_admin', reason: 'Off-topic', duration_hours: 1 },
      'moderator',
    );
    expect(ban.active).toBe(true);
    expect(Date.parse(ban.expires_at!)).toBeGreaterThan(
      Date.parse(ban.created_at),
    );
    await connection.query(
      'UPDATE community_bans SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?',
      [ban.id],
    );
    expect(await rows(ACTIVE_COMMUNITY_BAN_SQL, ['c-a', 'admin'])).toEqual([]);
    const listed = await bans.list(
      'a-community',
      'creator',
      Object.assign(new ListCommunityBansDto(), { active: 'lifted' }),
    );
    expect(listed.items.map((item) => item.id)).toContain(ban.id);
    // Still liftable explicitly.
    await bans.lift('a-community', 'platform_admin', {}, 'creator');
    expect(
      (
        await rows('SELECT lifted_at FROM community_bans WHERE id = ?', [
          ban.id,
        ])
      )[0].lifted_at,
    ).not.toBeNull();
    expect(await count('SELECT COUNT(*) AS total FROM user_restrictions')).toBe(
      0,
    );
  });

  it('logs each decision in the community moderation log', async () => {
    const actions = (
      await rows(
        "SELECT action FROM community_moderation_actions WHERE community_id = 'c-a' ORDER BY created_at, action",
      )
    ).map((row) => String(row.action));
    expect(actions.sort()).toEqual([
      'member_banned',
      'member_banned',
      'member_unbanned',
    ]);
  });
});
