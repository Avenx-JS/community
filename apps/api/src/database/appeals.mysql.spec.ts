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
import { AdminContentService } from '../admin/admin-content.service';
import { AdminRestrictionsService } from '../admin/admin-restrictions.service';
import { AuditLogService } from '../admin/audit-log.service';
import { AdminAppealsService } from '../appeals/admin-appeals.service';
import { AppealsService } from '../appeals/appeals.service';
import type { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { snapshotBefore } from './enum-history';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '048_create_appeals';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 048 undone (enum-history.ts); the runner applies it.
const preceding = snapshotBefore(snapshot, '048');

// Migration 048 through the real runner, then appeals with the real
// services on a real server: filing and its refusals, the queue, and
// deciding, whose approval reverses the decision through the administrator
// services in one transaction. Opt in with MYSQL_INTEGRATION_TEST=true and
// MYSQL_* credentials that may create and drop scratch databases; skipped
// otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('appeals (MySQL)', () => {
  const database = `appeals_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let appeals: AppealsService;
  let admin: AdminAppealsService;
  let communities: AdminCommunitiesService;
  let content: AdminContentService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const schema = (name: string) =>
    rows(
      `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS n,
              column_default AS d, generation_expression AS g
       FROM information_schema.columns
       WHERE table_schema = ? AND (table_name = 'appeals'
         OR (table_name = 'admin_actions' AND column_name IN ('action', 'target_type'))
         OR (table_name = 'notifications' AND column_name IN ('type', 'subject_type')))
       ORDER BY 1, 2`,
      [name],
    );
  const indexes = (name: string) =>
    rows(
      `SELECT index_name AS i, non_unique AS u, seq_in_index AS s, column_name AS c
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'appeals'
       ORDER BY 1, 3`,
      [name],
    );
  const checks = (name: string) =>
    rows(
      `SELECT constraint_name AS n, check_clause AS c
       FROM information_schema.check_constraints
       WHERE constraint_schema = ? AND constraint_name LIKE 'chk_appeals%'`,
      [name],
    );
  const actions = async () =>
    (
      await rows(
        "SELECT action, target_id FROM admin_actions WHERE action LIKE 'appeal_%' OR action IN ('restriction_lifted', 'post_restored', 'community_restored') ORDER BY created_at, action",
      )
    ).map((row) => `${row.action}:${row.target_id}`);
  const reason = 'This decision was a mistake.';
  const appealId = async (targetId: string) =>
    String(
      (
        await rows('SELECT id FROM appeals WHERE target_id = ? LIMIT 1', [
          targetId,
        ])
      )[0].id,
    );

  beforeAll(async () => {
    expect(preceding).not.toMatch(/appeal/);
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
    const log: string[] = [];
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
    await runMigrations(runner, await loadMigrations(migrations), (line) =>
      log.push(line),
    );
    firstRun = log.filter((line) => !line.startsWith('Skipped'));

    // root and rex are administrators; sam a user, owner of garden.
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash, role) VALUES
        ('root', 'root', 'root@example.test', 'x', 'admin'),
        ('rex', 'rex', 'rex@example.test', 'x', 'admin'),
        ('sam', 'sam', 'sam@example.test', 'x', 'user'),
        ('mod', 'mod', 'mod@example.test', 'x', 'user'),
        ('eve', 'eve', 'eve@example.test', 'x', 'user');
      INSERT INTO communities (id, creator_id, name) VALUES ('k-1', 'sam', 'garden');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-1', 'Tomatoes', 'Body', 'sam', 'k-1'),
        ('p-2', 'Beans', 'Body', 'sam', 'k-1');
      UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'mod', removal_reason = 'Off-topic' WHERE id = 'p-2';
      INSERT INTO user_restrictions (id, user_id, type, reason, created_by, expires_at) VALUES
        ('r-1', 'sam', 'suspension', 'Spam', 'root', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY));
      INSERT INTO user_restrictions (id, user_id, type, reason, created_by, created_at) VALUES
        ('r-old', 'eve', 'ban', 'Old', 'root', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 DAY));`);

    pool = createPool({ ...credentials, database, connectionLimit: 4 });
    const auditLog = new AuditLogService(pool);
    const notifications = new NotificationsService(pool);
    communities = new AdminCommunitiesService(pool, auditLog);
    content = new AdminContentService(pool, auditLog, notifications);
    appeals = new AppealsService(pool);
    admin = new AdminAppealsService(
      pool,
      auditLog,
      notifications,
      new AdminRestrictionsService(
        pool,
        auditLog,
        { logoutAll: () => Promise.resolve() } as unknown as AuthService,
        notifications,
      ),
      content,
      communities,
    );
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  it('applies 048, matching a fresh installation', async () => {
    expect(firstRun.join('\n')).toContain(VERSION);
    expect(await schema(database)).toEqual(await schema(fresh));
    expect(await indexes(database)).toEqual(await indexes(fresh));
    expect(await checks(database)).toEqual(await checks(fresh));
    expect(await checks(database)).toHaveLength(1);
  });

  it('files an appeal of a restriction, snapshotting the decision', async () => {
    const appeal = await appeals.create('sam', {
      target_type: 'restriction',
      target_id: 'r-1',
      reason,
    });
    expect(appeal).toMatchObject({ status: 'open', decision_note: null });
    const [row] = await rows(
      `SELECT a.original_actor_id, a.original_reason,
              a.original_decided_at = r.created_at AS same, a.open_target_id
       FROM appeals a JOIN user_restrictions r ON r.id = a.target_id WHERE a.id = ?`,
      [appeal.id],
    );
    expect(row).toEqual({
      original_actor_id: 'root',
      original_reason: 'Spam',
      same: 1,
      open_target_id: 'r-1',
    });
  });

  it('refuses a second appeal, a stranger, a moderator’s removal and an old decision', async () => {
    const restriction = {
      target_type: 'restriction' as const,
      target_id: 'r-1',
      reason,
    };
    await expect(appeals.create('sam', restriction)).rejects.toMatchObject({
      status: 409,
    });
    await expect(appeals.create('eve', restriction)).rejects.toMatchObject({
      status: 404,
    });
    const moderated = await appeals
      .create('sam', { target_type: 'post_removal', target_id: 'p-2', reason })
      .catch((error: { getResponse(): unknown }) => error.getResponse());
    expect(moderated).toMatchObject({
      reason: 'community_moderation',
      community_name: 'garden',
    });
    await expect(
      appeals.create('eve', {
        target_type: 'restriction',
        target_id: 'r-old',
        reason,
      }),
    ).rejects.toThrow('can be appealed for 30 days');
    await expect(
      appeals.create('sam', {
        target_type: 'post_removal',
        target_id: 'p-1',
        reason,
      }),
    ).rejects.toThrow('no longer in force');
  });

  it('enforces one open appeal per target and the decision check in the database', async () => {
    await expect(
      connection.query(
        `INSERT INTO appeals (id, user_id, target_type, target_id, reason, original_decided_at)
         VALUES ('dup', 'sam', 'restriction', 'r-1', 'x', '2020-01-01 00:00:00')`,
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(
      connection.query(
        `INSERT INTO appeals (id, user_id, target_type, target_id, reason, original_decided_at, status)
         VALUES ('bad', 'sam', 'post_removal', 'p-9', 'x', '2020-01-01 00:00:00', 'approved')`,
      ),
    ).rejects.toMatchObject({ code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
  });

  it('queues open appeals oldest first, with the original decision', async () => {
    const list = await admin.findAll({});
    expect(list.items.map((item) => item.target_id)).toEqual(['r-1']);
    expect(list.items[0]).toMatchObject({
      user: { id: 'sam', username: 'sam' },
      original_decision: { reason: 'Spam', actor_username: 'root' },
      target: { restriction_type: 'suspension', in_force: true },
    });
  });

  it('keeps the original administrator from deciding while another exists', async () => {
    const id = await appealId('r-1');
    await expect(
      admin.decide(id, { status: 'approved', decision_note: 'Ok' }, 'root'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('approves, lifting the restriction, auditing and notifying in one transaction', async () => {
    const id = await appealId('r-1');
    const detail = await admin.decide(
      id,
      { status: 'approved', decision_note: 'Mistaken identity.' },
      'rex',
    );
    expect(detail).toMatchObject({
      status: 'approved',
      decision_note: 'Mistaken identity.',
      decided_by_username: 'rex',
      target: { in_force: false },
      restriction: {
        id: 'r-1',
        active: false,
        lift_reason: 'Mistaken identity.',
      },
    });
    expect(await actions()).toEqual([
      'restriction_lifted:r-1',
      `appeal_approved:${id}`,
    ]);
    expect(
      await rows(
        "SELECT type, subject_id, metadata FROM notifications WHERE recipient_id = 'sam' ORDER BY type",
      ),
    ).toEqual([
      {
        type: 'appeal_decided',
        subject_id: id,
        metadata: {
          status: 'approved',
          appeal_target_type: 'restriction',
          decision_note: 'Mistaken identity.',
        },
      },
      {
        type: 'restriction_lifted',
        subject_id: 'r-1',
        metadata: { restriction_type: 'suspension' },
      },
    ]);
    await expect(
      admin.decide(id, { status: 'rejected', decision_note: 'No' }, 'rex'),
    ).rejects.toMatchObject({ status: 409 });
    await expect(appeals.listOwn('sam', {})).resolves.toMatchObject({
      total: 1,
      items: [{ status: 'approved', decision_note: 'Mistaken identity.' }],
    });
  });

  it('rejects an appeal of an administrator’s removal, which stays removed', async () => {
    await content.removePost('p-1', { reason: 'Spam link' }, 'root');
    const appeal = await appeals.create('sam', {
      target_type: 'post_removal',
      target_id: 'p-1',
      reason,
    });
    await admin.decide(
      appeal.id,
      { status: 'rejected', decision_note: 'The link is spam.' },
      'rex',
    );
    const [post] = await rows(
      "SELECT removed_at IS NOT NULL AS removed, removed_by_admin FROM posts WHERE id = 'p-1'",
    );
    expect(post).toEqual({ removed: 1, removed_by_admin: 1 });
    // One appeal per decision, even once decided.
    await expect(
      appeals.create('sam', {
        target_type: 'post_removal',
        target_id: 'p-1',
        reason,
      }),
    ).rejects.toThrow('already been appealed');
  });

  it('approves without error a decision reversed meanwhile, leaving a later one alone', async () => {
    await communities.suspend('k-1', { reason: 'Spam network' }, 'root');
    const appeal = await appeals.create('sam', {
      target_type: 'community_suspension',
      target_id: 'k-1',
      reason,
    });
    await communities.restore('k-1', { restore_reason: 'Reviewed' }, 'rex');
    // A second, later suspension: a decision of its own.
    await connection.query(
      "UPDATE communities SET suspended_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), suspended_by = 'root', suspension_reason = 'Again' WHERE id = 'k-1'",
    );
    const detail = await admin.decide(
      appeal.id,
      { status: 'approved', decision_note: 'Already restored.' },
      'rex',
    );
    expect(detail.status).toBe('approved');
    const [community] = await rows(
      "SELECT suspended_at IS NOT NULL AS suspended FROM communities WHERE id = 'k-1'",
    );
    expect(community).toEqual({ suspended: 1 });
    const [audit] = await rows(
      'SELECT metadata FROM admin_actions WHERE target_id = ? LIMIT 1',
      [appeal.id],
    );
    expect(audit.metadata).toMatchObject({ reversed: 'false' });
    // The later suspension can be appealed in turn.
    await expect(
      appeals.create('sam', {
        target_type: 'community_suspension',
        target_id: 'k-1',
        reason,
      }),
    ).resolves.toMatchObject({ status: 'open' });
  });

  it('details an appeal with the user’s other appeals', async () => {
    const id = await appealId('r-1');
    const detail = await admin.findOne(id);
    expect(detail.prior_appeal_count).toBe(3);
    expect(detail.prior_appeals).toHaveLength(3);
    expect(detail.post).toBeNull();
  });
});
