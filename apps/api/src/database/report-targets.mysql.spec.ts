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
import { AdminReportsService } from '../admin/admin-reports.service';
import { AuditLogService } from '../admin/audit-log.service';
import type { ListReportsDto } from '../admin/dto/list-reports.dto';
import { NotificationsService } from '../notifications/notifications.service';
import type { CreateReportDto } from '../reports/dto/create-report.dto';
import { ReportsService } from '../reports/reports.service';
import { runSqlScript } from './sql-script';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// Report targets against a real MySQL server: what each target type stores, the
// duplicate check under concurrency, and the queue's joins, which a stubbed pool
// cannot check. A community report has a NULL reported_user_id, so an INNER JOIN
// would hide it and a bare <> guard would refuse to transition it. Opt in with
// MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may create and drop
// scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('report targets (MySQL)', () => {
  const database = `report_targets_${randomBytes(4).toString('hex')}`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  let connection: Connection;
  let pool: Pool;
  let reports: ReportsService;
  let queue: AdminReportsService;

  const rows = async (sql: string, values: unknown[] = []) => {
    const [result] = await connection.query<RowDataPacket[]>(sql, values);
    return result;
  };
  const report = (
    target_type: CreateReportDto['target_type'],
    target: string,
    reporter = 'reporter',
  ) => reports.create({ target_type, target, reason: 'spam' }, reporter);
  const stored = async (id: string) =>
    (
      await rows(
        `SELECT reported_user_id, target_type, target_id, target_author_id,
                context_type, context_id
         FROM user_reports WHERE id = ?`,
        [id],
      )
    )[0];
  const list = (query: Partial<ListReportsDto> = {}) =>
    queue.findAll({ limit: 100, ...query } as ListReportsDto);

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
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('reporter', 'reporter', 'reporter@example.test', 'x'),
        ('second', 'second', 'second@example.test', 'x'),
        ('author', 'author', 'author@example.test', 'x'),
        ('creator', 'creator', 'creator@example.test', 'x'),
        ('admin', 'admin', 'admin@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES
        ('c-live', 'creator', 'live-one'),
        ('c-deleted', 'creator', 'deleted-one'),
        ('c-suspended', 'creator', 'suspended-one'),
        ('c-own', 'reporter', 'own-one');
      UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = 'creator'
        WHERE id = 'c-deleted';
      UPDATE communities SET suspended_at = UTC_TIMESTAMP() WHERE id = 'c-suspended';
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-1', 'First title', 'First body', 'author', 'c-live'),
        ('p-2', 'Second title', 'Second body', 'author', 'c-live'),
        ('p-removed', 'Removed title', 'Removed body', 'author', 'c-live'),
        ('p-in-deleted', 'In deleted', 'Body', 'author', 'c-deleted'),
        ('p-own', 'Own', 'Body', 'reporter', 'c-live'),
        ('p-doomed', 'Doomed title', 'Doomed body', 'author', 'c-live'),
        ('shared-id', 'Shared post title', 'Body', 'author', 'c-live');
      UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = 'admin'
        WHERE id = 'p-removed';
      INSERT INTO comments (id, post_id, author_id, content) VALUES
        ('m-1', 'p-1', 'author', 'A comment body'),
        ('m-long', 'p-1', 'author', REPEAT('x', 300)),
        ('m-removed', 'p-1', 'author', 'Removed comment'),
        ('m-own', 'p-1', 'reporter', 'Own comment'),
        ('shared-id', 'p-1', 'author', 'Shared comment body');
      UPDATE comments SET removed_at = UTC_TIMESTAMP(), removed_by = 'admin'
        WHERE id = 'm-removed';`);

    pool = createPool({ ...credentials, database, connectionLimit: 8 });
    reports = new ReportsService(pool);
    queue = new AdminReportsService(
      pool,
      new AuditLogService(pool),
      new NotificationsService(pool),
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.end();
  });

  describe('what each target type stores', () => {
    it('stores a post target through its author', async () => {
      const { id } = await report('post', 'p-1');
      expect(await stored(id)).toEqual({
        reported_user_id: 'author',
        target_type: 'post',
        target_id: 'p-1',
        target_author_id: 'author',
        context_type: null,
        context_id: null,
      });
    });

    it('stores a comment target through its author', async () => {
      const { id } = await report('comment', 'm-1');
      expect(await stored(id)).toMatchObject({
        reported_user_id: 'author',
        target_type: 'comment',
        target_id: 'm-1',
        target_author_id: 'author',
      });
    });

    it('stores a community target with no account', async () => {
      const { id } = await report('community', 'live-one');
      expect(await stored(id)).toMatchObject({
        reported_user_id: null,
        target_type: 'community',
        target_id: 'c-live',
        target_author_id: null,
      });
    });

    it('stores a user target as it always did', async () => {
      const { id } = await report('user', 'author', 'second');
      expect(await stored(id)).toMatchObject({
        reported_user_id: 'author',
        target_type: 'user',
        target_id: 'author',
        target_author_id: null,
      });
    });

    it.each([
      ['post', 'p-removed'],
      ['post', 'p-in-deleted'],
      ['comment', 'm-removed'],
      ['community', 'deleted-one'],
      ['community', 'suspended-one'],
    ] as const)('accepts the hidden %s %s', async (type, target) => {
      await expect(report(type, target)).resolves.toMatchObject({
        status: 'open',
      });
    });

    it.each([
      ['post', 'p-own'],
      ['comment', 'm-own'],
      ['community', 'own-one'],
      ['user', 'reporter'],
    ] as const)('refuses your own %s with 400', async (type, target) => {
      await expect(report(type, target)).rejects.toMatchObject({ status: 400 });
    });

    it.each([
      ['post', 'no-such-post'],
      ['comment', 'no-such-comment'],
      ['community', 'no-such-community'],
      ['user', 'no_such_user'],
    ] as const)('answers an unknown %s with 404', async (type, target) => {
      await expect(report(type, target)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('duplicates', () => {
    it('accepts another post by the same author, and refuses a repeat', async () => {
      // p-1 is already reported above.
      await expect(report('post', 'p-2')).resolves.toMatchObject({
        status: 'open',
      });
      await expect(report('post', 'p-2')).rejects.toMatchObject({
        status: 409,
      });
    });

    it('keeps a post and a comment with one id apart', async () => {
      await report('post', 'shared-id');
      await expect(report('comment', 'shared-id')).resolves.toMatchObject({
        status: 'open',
      });
    });

    it('lets exactly one of many concurrent submissions through', async () => {
      await connection.query(`
        INSERT INTO posts (id, title, content, author_id, community_id)
        VALUES ('p-race', 'Race', 'Body', 'author', 'c-live')`);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => report('post', 'p-race', 'second')),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({ status: 409 });
        }
      }
      expect(
        await rows("SELECT id FROM user_reports WHERE target_id = 'p-race'"),
      ).toHaveLength(1);
    });
  });

  describe('the queue', () => {
    const labelOf = async (type: string, targetId: string) =>
      (await list()).items.find(
        (item) => item.target_type === type && item.target_id === targetId,
      )?.target_label;

    it('shows every target type in one ordered stream', async () => {
      const { items, total } = await list();
      expect(new Set(items.map((item) => item.target_type))).toEqual(
        new Set(['user', 'post', 'comment', 'community']),
      );
      const [{ count }] = await rows(
        'SELECT COUNT(*) AS count FROM user_reports',
      );
      expect(total).toBe(Number(count));
      expect(items).toHaveLength(total);
      const order = items.map((item) => item.created_at);
      expect(order).toEqual([...order].sort().reverse());
    });

    it.each(['user', 'post', 'comment', 'community'] as const)(
      'filters on target_type=%s, with a matching total',
      async (target_type) => {
        const { items, total, filters } = await list({ target_type });
        expect(items.length).toBeGreaterThan(0);
        expect(items).toHaveLength(total);
        expect(items.every((item) => item.target_type === target_type)).toBe(
          true,
        );
        expect(filters.target_type).toBe(target_type);
      },
    );

    it('matches user and content reports on reported_username, never community ones', async () => {
      const { items } = await list({ reported_username: 'author' });
      const types = new Set(items.map((item) => item.target_type));
      expect(types).toEqual(new Set(['user', 'post', 'comment']));
      expect(types).not.toContain('community');
    });

    it('labels each kind of target', async () => {
      expect(await labelOf('user', 'author')).toBe('author');
      expect(await labelOf('post', 'p-1')).toBe('First title');
      expect(await labelOf('comment', 'm-1')).toBe('A comment body');
      expect(await labelOf('community', 'c-live')).toBe('live-one');
    });

    it('resolves a shared id through the report’s own type', async () => {
      expect(await labelOf('post', 'shared-id')).toBe('Shared post title');
      expect(await labelOf('comment', 'shared-id')).toBe('Shared comment body');
    });

    it('truncates a comment’s label', async () => {
      await report('comment', 'm-long');
      expect(await labelOf('comment', 'm-long')).toHaveLength(100);
    });

    it('still labels removed content and hidden communities', async () => {
      expect(await labelOf('post', 'p-removed')).toBe('Removed title');
      expect(await labelOf('community', 'c-deleted')).toBe('deleted-one');
    });

    it('keeps a report whose target is then deleted, with a null label, without throwing', async () => {
      const { id } = await report('post', 'p-doomed');
      await connection.query("DELETE FROM posts WHERE id = 'p-doomed'");

      expect(await labelOf('post', 'p-doomed')).toBeNull();
      await expect(queue.findOne(id)).resolves.toMatchObject({
        target_type: 'post',
        target_id: 'p-doomed',
        target_label: null,
        target_content: null,
      });
    });

    it('shows a report whose reported account was hard-deleted', async () => {
      await connection.query(`
        INSERT INTO users (id, username, email, password_hash)
          VALUES ('gone', 'gone_user', 'gone@example.test', 'x');
        INSERT INTO user_reports
          (id, reporter_id, reported_user_id, reason, target_type, target_id)
          VALUES ('r-gone', 'reporter', 'gone', 'spam', 'user', 'gone');
        DELETE FROM users WHERE id = 'gone';`);

      await expect(queue.findOne('r-gone')).resolves.toMatchObject({
        reported_username: null,
        target_label: null,
        open_reports_against_user: 0,
      });
    });
  });

  describe('the detail route', () => {
    const reportIdOf = async (type: string, targetId: string) =>
      String(
        (
          await rows(
            'SELECT id FROM user_reports WHERE target_type = ? AND target_id = ? LIMIT 1',
            [type, targetId],
          )
        )[0].id,
      );

    it('returns a post in full', async () => {
      await expect(
        queue.findOne(await reportIdOf('post', 'p-1')),
      ).resolves.toMatchObject({
        target_content: {
          title: 'First title',
          content: 'First body',
          removed: false,
        },
        open_reports_against_user: expect.any(Number) as unknown,
      });
    });

    it('returns a comment in full, past the label’s length', async () => {
      const detail = await queue.findOne(await reportIdOf('comment', 'm-long'));
      expect(detail.target_content?.title).toBeNull();
      expect(detail.target_content?.content).toHaveLength(300);
    });

    it('keeps removed content readable, and says it was removed', async () => {
      await expect(
        queue.findOne(await reportIdOf('post', 'p-removed')),
      ).resolves.toMatchObject({
        target_content: { content: 'Removed body', removed: true },
      });
    });

    it('returns no content and no account counts for a community', async () => {
      await expect(
        queue.findOne(await reportIdOf('community', 'c-live')),
      ).resolves.toMatchObject({
        reported_username: null,
        target_label: 'live-one',
        target_content: null,
        open_reports_against_user: 0,
        total_reports_against_user: 0,
        prior_resolutions_against_user: [],
      });
    });

    it('never returns an email or a credential', async () => {
      const detail = await queue.findOne(await reportIdOf('user', 'author'));
      expect(JSON.stringify(detail)).not.toMatch(
        /@example\.test|password|session/,
      );
    });
  });

  describe('transitions', () => {
    // A bare reported_user_id <> ? is NULL for a community report, which would
    // match no row and report a false concurrent change.
    it.each([
      ['community', 'c-suspended'],
      ['post', 'p-2'],
      ['comment', 'm-1'],
      ['user', 'author'],
    ])(
      'moves a %s report, telling the reporter { status } only',
      async (type, targetId) => {
        const [{ id }] = await rows(
          'SELECT id FROM user_reports WHERE target_type = ? AND target_id = ? LIMIT 1',
          [type, targetId],
        );
        const reportId = String(id);

        await expect(
          queue.updateStatus(reportId, { status: 'under_review' }, 'admin'),
        ).resolves.toMatchObject({ status: 'under_review' });
        await expect(
          queue.updateStatus(
            reportId,
            {
              status: 'resolved',
              resolution: 'no_action',
              resolution_note: 'Internal note',
            },
            'admin',
          ),
        ).resolves.toMatchObject({
          status: 'resolved',
          target_type: type,
          target_id: targetId,
        });

        const [notification] = await rows(
          "SELECT metadata FROM notifications WHERE subject_type = 'report' AND subject_id = ?",
          [reportId],
        );
        expect(JSON.stringify(notification.metadata)).toBe(
          JSON.stringify({ status: 'resolved' }),
        );
      },
    );

    it('still refuses a reviewer who wrote the reported content', async () => {
      const { id } = await report('comment', 'm-removed', 'second');
      await expect(
        queue.updateStatus(id, { status: 'under_review' }, 'author'),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});
