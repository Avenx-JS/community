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
import { CommentRemovalService } from '../comments/comment-removals.service';
import { CommentsService } from '../comments/comments.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import {
  CommunityReportsService,
  modQueueSql,
} from '../reports/community-reports.service';
import { ReportsService } from '../reports/reports.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '036_add_community_report_review';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 036 undone.
const preceding = snapshot
  .replace(/ {4}community_(id|status|reviewed_by|reviewed_at) [^\n]*\n/g, '')
  .replace(/ {4}INDEX idx_user_reports_(modqueue|community) [^\n]*\n/g, '')
  .replace(
    /,\r?\n {4}CONSTRAINT fk_user_reports_community\r?\n[^\n]*\r?\n {4}CONSTRAINT fk_user_reports_community_reviewed_by\r?\n[^\n]*(?=\r?\n\);)/,
    '',
  )
  .replace(/,\r?\n\s*'report_approved',\r?\n\s*'report_removed'/, '')
  .replace(/,\r?\n\s*\('036_add_community_report_review'\)/, '');

// Migration 036 through the real runner over a database at 035 that holds
// reports in every state, then the review flow with the real services.
// Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials that may
// create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('community report review (MySQL)', () => {
  const database = `community_report_review_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  const accepting = {
    assertAcceptedOrThrow: () => Promise.resolve(),
  } as unknown as CommunityRuleAcceptanceService;
  let connection: Connection;
  let pool: Pool;
  let reports: ReportsService;
  let review: CommunityReportsService;
  let firstRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
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
  const TABLES = "('user_reports', 'community_moderation_actions')";
  const schema = async (name: string) => ({
    columns: await rows(
      `SELECT table_name AS t, column_name AS name, column_type AS type, is_nullable AS nullable
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name IN ${TABLES} ORDER BY table_name, column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT table_name AS t, index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name IN ${TABLES}
       GROUP BY table_name, index_name ORDER BY table_name, index_name`,
      [name],
    ),
  });
  const report = (
    target_type: 'post' | 'comment',
    target: string,
    reporter: string,
  ) =>
    reports.create({ target_type, target, reason: 'spam' } as never, reporter);
  const state = async (id: string) =>
    (
      await rows(
        'SELECT status, community_id, community_status, community_reviewed_by FROM user_reports WHERE id = ?',
        [id],
      )
    )[0];

  beforeAll(async () => {
    expect(preceding).not.toMatch(
      /community_status|idx_user_reports_modqueue|report_approved/,
    );
    expect(preceding).not.toContain(VERSION);
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
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('author', 'author', 'author@example.test', 'x'),
        ('creator', 'creator', 'creator@example.test', 'x'),
        ('moderator', 'moderator', 'moderator@example.test', 'x'),
        ('reader-a', 'reader_a', 'a@example.test', 'x'),
        ('reader-b', 'reader_b', 'b@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES ('c-garden', 'creator', 'garden');
      INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES ('c-garden', 'moderator', 'creator');
      INSERT INTO posts (id, title, content, author_id, community_id) VALUES
        ('p-1', 'One', 'Body', 'author', 'c-garden'),
        ('p-2', 'Two', 'Body', 'author', 'c-garden'),
        ('p-3', 'Three', 'Body', 'author', 'c-garden');
      INSERT INTO comments (id, post_id, author_id, content) VALUES ('m-1', 'p-1', 'author', 'Rude');
      INSERT INTO user_reports (id, reporter_id, reported_user_id, reason, target_type, target_id, target_author_id, status, withdrawn_at) VALUES
        ('old-open', 'reader-a', 'author', 'spam', 'post', 'p-3', 'author', 'open', NULL),
        ('old-comment', 'reader-a', 'author', 'spam', 'comment', 'm-1', 'author', 'under_review', NULL),
        ('old-resolved', 'reader-b', 'author', 'spam', 'post', 'p-3', 'author', 'resolved', NULL),
        ('old-withdrawn', 'reader-b', 'author', 'spam', 'post', 'p-2', 'author', 'open', UTC_TIMESTAMP()),
        ('old-user', 'reader-a', 'author', 'spam', 'user', 'author', NULL, 'open', NULL);`);
    firstRun = await migrate();

    pool = createPool({ ...credentials, database, connectionLimit: 6 });
    const log = new CommunityModerationLogService(pool);
    const notifications = new NotificationsService(pool);
    const comments = new CommentsService(pool, notifications, accepting);
    reports = new ReportsService(pool);
    review = new CommunityReportsService(
      pool,
      log,
      new PostsService(pool, notifications, accepting, log),
      new CommentRemovalService(pool, comments, notifications, log),
    );
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
  });

  describe('migration 036', () => {
    it('applies, matching a fresh installation', async () => {
      expect(firstRun.join('\n')).toContain(VERSION);
      expect(await schema(database)).toEqual(await schema(fresh));
    });

    it('routes the open content reports of before, and only those', async () => {
      expect(await state('old-open')).toMatchObject({
        community_id: 'c-garden',
        community_status: 'open',
      });
      expect(await state('old-comment')).toMatchObject({
        community_id: 'c-garden',
        community_status: 'open',
      });
      expect(await state('old-resolved')).toMatchObject({
        community_id: 'c-garden',
        community_status: null,
      });
      expect(await state('old-withdrawn')).toMatchObject({
        community_id: 'c-garden',
        community_status: null,
      });
      expect(await state('old-user')).toMatchObject({
        community_id: null,
        community_status: null,
      });
    });
  });

  describe('the review flow', () => {
    it('serves the queue from idx_user_reports_modqueue', async () => {
      const plan = await rows(`EXPLAIN ${modQueueSql('oldest', false)}`, [
        'c-garden',
        20,
        0,
      ]);
      expect(plan[0].key).toBe('idx_user_reports_modqueue');
      expect(plan[0].type).not.toBe('ALL');
    });

    it('gathers the reports of one post, approves them together, and keeps the reporter out', async () => {
      const a = await report('post', 'p-1', 'reader-a');
      const b = await report('post', 'p-1', 'reader-b');
      const queue = await review.modQueue('garden', 'moderator', {});
      expect(
        queue.items.find((entry) => entry.target_id === 'p-1'),
      ).toMatchObject({ report_count: 2, reporter_count: 2 });
      expect(JSON.stringify(queue)).not.toMatch(
        /reader-a|reader-b|reader_a|reader_b/,
      );

      await review.approve('garden', 'moderator', a.id);
      expect(await state(a.id)).toMatchObject({
        community_status: 'approved',
        community_reviewed_by: 'moderator',
        status: 'open',
      });
      expect(await state(b.id)).toMatchObject({ community_status: 'approved' });
      expect(
        await rows(
          "SELECT action, target_id, metadata FROM community_moderation_actions WHERE action = 'report_approved'",
        ),
      ).toEqual([
        expect.objectContaining({ target_id: 'p-1', metadata: { reports: 2 } }),
      ]);

      // The approved post leaves the queue, and its reporter cannot reopen it.
      expect(
        (await review.modQueue('garden', 'moderator', {})).items.map(
          (e) => e.target_id,
        ),
      ).not.toContain('p-1');
      await expect(report('post', 'p-1', 'reader-a')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect((await reports.findOwn(a.id, 'reader-a')).community_status).toBe(
        'approved',
      );
    });

    it('removes a post and closes its reports in one transaction', async () => {
      const r = await report('post', 'p-2', 'reader-a');
      await review.remove('garden', 'creator', r.id, { reason: 'Spam' });
      expect(
        (
          await rows(
            "SELECT removed_by, removal_reason FROM posts WHERE id = 'p-2'",
          )
        )[0],
      ).toEqual({
        removed_by: 'creator',
        removal_reason: 'Spam',
      });
      expect(await state(r.id)).toMatchObject({ community_status: 'removed' });
      expect(
        (
          await rows(
            "SELECT action FROM community_moderation_actions WHERE target_id = 'p-2' ORDER BY created_at, action",
          )
        ).map((row) => String(row.action)),
      ).toEqual(expect.arrayContaining(['post_removed', 'report_removed']));
    });

    it('closes the backfilled comment report through the comment removal path', async () => {
      await review.remove('garden', 'moderator', 'old-comment', {});
      expect(
        (await rows("SELECT removed_at FROM comments WHERE id = 'm-1'"))[0]
          .removed_at,
      ).not.toBeNull();
      expect(await state('old-comment')).toMatchObject({
        community_status: 'removed',
        status: 'under_review',
      });
    });

    it('refuses anyone who does not moderate the community', async () => {
      await expect(
        review.modQueue('garden', 'reader-a', {}),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});
