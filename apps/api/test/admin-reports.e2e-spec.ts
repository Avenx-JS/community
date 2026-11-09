import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import { UsersService } from '../src/users/users.service';
import type { PlatformRole } from '../src/users/users.service';

interface ReportFixture {
  id: string;
  reporter_username: string | null;
  reported_username: string | null;
  target_type: string;
  target_id: string;
  target_label: string | null;
  reason: string;
  status: string;
  resolution: string | null;
  context_type: 'post' | 'comment' | null;
  context_id: string | null;
  created_at: string;
  reviewed_at: string | null;
  resolution_note: string | null;
  withdrawn_at: string | null;
  // The assignee's id, and what the assignee join would resolve.
  assigned_to: string | null;
  assigned_to_username: string | null;
  assigned_at: string | null;
}

interface AdminListResponse {
  items: ReportFixture[];
  total: number;
  filters: Record<string, unknown>;
}

interface AdminDetailResponse {
  reporter_username: string | null;
  reviewed_by_username: string | null;
  context: Record<string, unknown> | null;
  open_reports_against_user: number;
  total_reports_against_user: number;
  prior_resolutions_against_user: Array<{
    resolution: string;
    total: number;
  }>;
}

describe('Admin reports API (e2e)', () => {
  let app: INestApplication<App>;
  let reports: ReportFixture[];
  let roles: Map<string, PlatformRole>;
  let poolCalls: Array<{ sql: string; values: unknown[] }>;
  let detailHasContext: boolean;
  let targetContents: Map<string, Record<string, unknown>>;
  let auditRows: unknown[][];
  let transactionCounts: {
    commits: number;
    rollbacks: number;
    releases: number;
  };
  let failAuditInsert: boolean;
  let notificationRows: Array<Record<string, unknown>>;
  let failNotificationInsert: boolean;
  let transactionNotificationStart: number;
  // id -> username of every account the fake knows. deleted marks an
  // anonymised account, which cannot be assigned.
  let directory: Map<string, { username: string; deleted?: boolean }>;
  let assignmentClock: number;
  let previousAssignment:
    | {
        report: ReportFixture;
        assigned_to: string | null;
        assigned_to_username: string | null;
        assigned_at: string | null;
      }
    | undefined;
  let previousReportState:
    | {
        report: ReportFixture;
        status: string;
        resolution: string | null;
        note: string | null;
        reviewedAt: string | null;
      }
    | undefined;

  beforeEach(async () => {
    reports = Array.from({ length: 25 }, (_, index) => ({
      id: `report-${String(index + 1).padStart(2, '0')}`,
      reporter_username: index === 0 ? null : `reporter_${index}`,
      reported_username: index % 2 === 0 ? 'target_user' : 'other_target',
      target_type: 'user',
      target_id: index % 2 === 0 ? 'target-id' : 'other-target-id',
      target_label: index % 2 === 0 ? 'target_user' : 'other_target',
      reason: index % 2 === 0 ? 'spam' : 'harassment',
      status: index < 12 ? 'open' : 'resolved',
      resolution: index < 12 ? null : 'no_action',
      context_type: index === 0 ? 'post' : null,
      context_id: index === 0 ? 'deleted-post' : null,
      created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      reviewed_at: null,
      resolution_note: null,
      withdrawn_at: null,
      assigned_to: null,
      assigned_to_username: null,
      assigned_at: null,
    }));
    roles = new Map([
      ['admin-id', 'admin'],
      ['user-id', 'user'],
    ]);
    poolCalls = [];
    detailHasContext = false;
    targetContents = new Map();
    auditRows = [];
    transactionCounts = { commits: 0, rollbacks: 0, releases: 0 };
    failAuditInsert = false;
    notificationRows = [];
    failNotificationInsert = false;
    transactionNotificationStart = 0;
    previousReportState = undefined;
    previousAssignment = undefined;
    assignmentClock = 0;
    directory = new Map([
      ['admin-id', { username: 'admin' }],
      ['admin2-id', { username: 'second_admin' }],
      ['user-id', { username: 'plain_user' }],
      ['reporter-id', { username: 'reporter_admin' }],
      ['target-id', { username: 'target_user' }],
      ['gone-admin-id', { username: 'gone_admin', deleted: true }],
    ]);
    roles.set('admin2-id', 'admin');
    roles.set('gone-admin-id', 'admin');

    const matchingReports = (sql: string, values: unknown[]) => {
      const where = sql.includes(' WHERE ')
        ? sql.slice(
            sql.indexOf(' WHERE '),
            sql.includes(' ORDER BY') ? sql.indexOf(' ORDER BY') : sql.length,
          )
        : '';
      let parameter = 0;
      let result = reports;
      const conditions = [
        [
          'ur.status = ?',
          (row: ReportFixture, value: unknown) => row.status === value,
        ],
        [
          'ur.reason = ?',
          (row: ReportFixture, value: unknown) => row.reason === value,
        ],
        [
          'reported_user.username = ?',
          (row: ReportFixture, value: unknown) =>
            row.reported_username === value,
        ],
        [
          'reporter_user.username = ?',
          (row: ReportFixture, value: unknown) =>
            row.reporter_username === value,
        ],
      ] as const;
      for (const [condition, matches] of conditions) {
        if (where.includes(condition)) {
          const value = values[parameter++];
          result = result.filter((row) => matches(row, value));
        }
      }
      const fromCondition =
        "ur.created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)";
      if (where.includes(fromCondition)) {
        const from = new Date(
          String(values[parameter++]).replace(' ', 'T') + 'Z',
        );
        result = result.filter((row) => new Date(row.created_at) >= from);
      }
      const toCondition =
        "ur.created_at < CONVERT_TZ(?, '+00:00', @@session.time_zone)";
      if (where.includes(toCondition)) {
        const to = new Date(
          String(values[parameter++]).replace(' ', 'T') + 'Z',
        );
        result = result.filter((row) => new Date(row.created_at) < to);
      }
      if (where.includes('ur.target_type = ?')) {
        const value = values[parameter++];
        result = result.filter((row) => row.target_type === value);
      }
      if (where.includes('ur.withdrawn_at IS NULL')) {
        result = result.filter((row) => row.withdrawn_at === null);
      }
      if (where.includes('ur.withdrawn_at IS NOT NULL')) {
        result = result.filter((row) => row.withdrawn_at !== null);
      }
      if (where.includes('ur.assigned_to = ?')) {
        const value = values[parameter++];
        result = result.filter((row) => row.assigned_to === value);
      }
      if (where.includes('ur.assigned_to IS NULL')) {
        result = result.filter((row) => row.assigned_to === null);
      }
      if (where.includes('assignee_user.username = ?')) {
        const value = values[parameter++];
        result = result.filter((row) => row.assigned_to_username === value);
      }
      return result;
    };

    const execute = (sql: string, values: unknown[]) => {
      poolCalls.push({ sql, values });
      // The inbox's listing and count, scoped to the recipient.
      if (sql.startsWith('SELECT COUNT(*) AS total FROM notifications')) {
        return Promise.resolve([
          [
            {
              total: notificationRows.filter(
                (row) => row.recipient_id === values[0],
              ).length,
            },
          ],
          [],
        ] as [unknown, unknown]);
      }
      if (
        sql.startsWith('SELECT id, type, subject_type') &&
        sql.includes('FROM notifications WHERE recipient_id = ?')
      ) {
        return Promise.resolve([
          notificationRows.filter((row) => row.recipient_id === values[0]),
          [],
        ] as [unknown, unknown]);
      }
      if (
        sql.startsWith('SELECT ur.id, reporter_user.username') &&
        !sql.includes('ur.description')
      ) {
        let result = matchingReports(sql, values);
        const direction = sql.includes('ur.created_at ASC') ? 1 : -1;
        result = [...result].sort(
          (left, right) =>
            direction *
            (left.created_at.localeCompare(right.created_at) ||
              left.id.localeCompare(right.id)),
        );
        const limit = Number(values[values.length - 2]);
        const offset = Number(values[values.length - 1]);
        return Promise.resolve([result.slice(offset, offset + limit), []] as [
          unknown,
          unknown,
        ]);
      }
      if (sql.startsWith('SELECT COUNT(*) AS total')) {
        return Promise.resolve([
          [{ total: matchingReports(sql, values).length }],
          [],
        ] as [unknown, unknown]);
      }
      if (
        sql.startsWith('SELECT ur.id, reporter_user.username') &&
        sql.includes('ur.description')
      ) {
        const report = reports.find((row) => row.id === values[0]);
        return Promise.resolve([
          report
            ? [
                {
                  ...report,
                  reporter_id: report.reporter_username ? 'reporter-id' : null,
                  reported_user_id: report.reported_username
                    ? 'target-id'
                    : null,
                  description: 'Accusation detail',
                  resolution_note: report.resolution_note,
                  reviewed_by_username: report.reviewed_at ? 'admin' : null,
                },
              ]
            : [],
          [],
        ] as [unknown, unknown]);
      }
      if (/^SELECT (title|NULL AS title), content, removed_at/.test(sql)) {
        const content = targetContents.get(values[0] as string);
        return Promise.resolve([content ? [content] : [], []] as [
          unknown,
          unknown,
        ]);
      }
      if (sql.startsWith('SELECT context.title')) {
        return Promise.resolve([
          detailHasContext
            ? [
                {
                  title: 'Post title',
                  content: 'Context body',
                  author_username: 'target_user',
                },
              ]
            : [],
          [],
        ] as [unknown, unknown]);
      }
      if (sql.includes('AS open_reports_against_user')) {
        return Promise.resolve([
          [{ open_reports_against_user: 12, total_reports_against_user: 25 }],
          [],
        ] as [unknown, unknown]);
      }
      if (sql.startsWith('SELECT resolution, COUNT(*)')) {
        return Promise.resolve([
          [{ resolution: 'no_action', total: 10 }],
          [],
        ] as [unknown, unknown]);
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };
    const connection = {
      beginTransaction: () => {
        transactionNotificationStart = notificationRows.length;
        return Promise.resolve();
      },
      commit: () => {
        transactionCounts.commits += 1;
        // A rollback only undoes its own transaction's assignment change.
        previousAssignment = undefined;
        return Promise.resolve();
      },
      rollback: () => {
        transactionCounts.rollbacks += 1;
        notificationRows = notificationRows.slice(
          0,
          transactionNotificationStart,
        );
        if (previousReportState) {
          previousReportState.report.status = previousReportState.status;
          previousReportState.report.resolution =
            previousReportState.resolution;
          previousReportState.report.resolution_note = previousReportState.note;
          previousReportState.report.reviewed_at =
            previousReportState.reviewedAt;
        }
        if (previousAssignment) {
          Object.assign(previousAssignment.report, {
            assigned_to: previousAssignment.assigned_to,
            assigned_to_username: previousAssignment.assigned_to_username,
            assigned_at: previousAssignment.assigned_at,
          });
          previousAssignment = undefined;
        }
        return Promise.resolve();
      },
      release: () => {
        transactionCounts.releases += 1;
      },
      execute: (sql: string, values: unknown[]) => {
        poolCalls.push({ sql, values });
        if (sql.startsWith('SELECT id, reporter_id, reported_user_id')) {
          const report = reports.find((row) => row.id === values[0]);
          return Promise.resolve([
            report
              ? [
                  {
                    id: report.id,
                    reporter_id: report.reporter_username
                      ? 'reporter-id'
                      : null,
                    reported_user_id: report.reported_username
                      ? 'target-id'
                      : null,
                    status: report.status,
                    withdrawn_at: report.withdrawn_at,
                    assigned_to: report.assigned_to,
                  },
                ]
              : [],
            [],
          ]);
        }
        if (sql.startsWith('SELECT id, username, role FROM users')) {
          const byId = sql.includes('WHERE id = ?');
          const entry = [...directory.entries()].find(([id, user]) =>
            byId ? id === values[0] : user.username === values[0],
          );
          return Promise.resolve([
            entry && !entry[1].deleted
              ? [
                  {
                    id: entry[0],
                    username: entry[1].username,
                    role: roles.get(entry[0]) ?? 'user',
                  },
                ]
              : [],
            [],
          ]);
        }
        if (
          sql.includes('SET assigned_to = ?, assigned_at = UTC_TIMESTAMP()')
        ) {
          const report = reports.find((row) => row.id === values[1]);
          if (
            !report ||
            report.withdrawn_at !== null ||
            !['open', 'under_review'].includes(report.status)
          ) {
            return Promise.resolve([{ affectedRows: 0 }, []]);
          }
          previousAssignment = {
            report,
            assigned_to: report.assigned_to,
            assigned_to_username: report.assigned_to_username,
            assigned_at: report.assigned_at,
          };
          report.assigned_to = String(values[0]);
          report.assigned_to_username =
            directory.get(String(values[0]))?.username ?? null;
          report.assigned_at = `2026-10-27T09:0${assignmentClock++}:00.000Z`;
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.includes('SET assigned_to = NULL, assigned_at = NULL')) {
          const report = reports.find(
            (row) => row.id === values[0] && row.assigned_to === values[1],
          );
          if (!report) {
            return Promise.resolve([{ affectedRows: 0 }, []]);
          }
          previousAssignment = {
            report,
            assigned_to: report.assigned_to,
            assigned_to_username: report.assigned_to_username,
            assigned_at: report.assigned_at,
          };
          Object.assign(report, {
            assigned_to: null,
            assigned_to_username: null,
            assigned_at: null,
          });
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('UPDATE user_reports')) {
          const report = reports.find((row) => row.id === values[4]);
          if (!report || report.withdrawn_at !== null) {
            return Promise.resolve([{ affectedRows: 0 }, []]);
          }
          previousReportState = {
            report,
            status: report.status,
            resolution: report.resolution,
            note: report.resolution_note,
            reviewedAt: report.reviewed_at,
          };
          report.status = String(values[0]);
          report.resolution = typeof values[1] === 'string' ? values[1] : null;
          report.resolution_note =
            typeof values[2] === 'string' ? values[2] : null;
          report.reviewed_at = '2026-10-26T12:00:00.000Z';
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
          return Promise.resolve([
            directory.has(String(values[0]))
              ? [{ username: directory.get(String(values[0]))!.username }]
              : [],
            [],
          ]);
        }
        if (sql.startsWith('INSERT INTO admin_actions')) {
          if (failAuditInsert) {
            return Promise.reject(new Error('Audit insert failed'));
          }
          auditRows.push(values);
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('INSERT INTO notifications')) {
          if (failNotificationInsert) {
            return Promise.reject(new Error('Notification insert failed'));
          }
          const [id, recipientId, type, actorId, subjectType, subjectId] =
            values as Array<string | null>;
          notificationRows.push({
            id,
            recipient_id: recipientId,
            type,
            actor_id: actorId,
            subject_type: subjectType,
            subject_id: subjectId,
            community_id: values[6],
            metadata: values[7],
            read_at: null,
            created_at: new Date('2026-10-26T12:00:00.000Z'),
          });
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        return Promise.reject(new Error(`Unexpected transaction SQL: ${sql}`));
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute,
        getConnection: () => Promise.resolve(connection),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) => {
          const userId = {
            'admin-token': 'admin-id',
            'target-token': 'target-id',
            'user-token': 'user-id',
            'reporter-token': 'reporter-id',
            'admin2-token': 'admin2-id',
          }[token];
          return Promise.resolve(
            userId ? { kind: 'valid', userId } : { kind: 'invalid' },
          );
        },
      })
      .overrideProvider(UsersService)
      .useValue({
        getPlatformRole: (userId: string) =>
          Promise.resolve(roles.get(userId) ?? null),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const adminRequest = (path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer admin-token');

  const adminPatch = (path: string) =>
    request(app.getHttpServer())
      .patch(path)
      .set('Authorization', 'Bearer admin-token');

  it('enforces authentication and admin authorization', async () => {
    await request(app.getHttpServer()).get('/admin/reports').expect(401);
    await request(app.getHttpServer())
      .patch('/admin/reports/report-01')
      .send({ status: 'under_review' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/admin/reports')
      .set('Authorization', 'Bearer user-token')
      .expect(403);
    await request(app.getHttpServer())
      .patch('/admin/reports/report-01')
      .set('Authorization', 'Bearer user-token')
      .send({ status: 'under_review' })
      .expect(403);
    await adminRequest('/admin/reports').expect(200);
  });

  it('paginates with stable order and applies every supported filter', async () => {
    const first = await adminRequest('/admin/reports?limit=10&page=1').expect(
      200,
    );
    const second = await adminRequest('/admin/reports?limit=10&page=2').expect(
      200,
    );
    const third = await adminRequest('/admin/reports?limit=10&page=3').expect(
      200,
    );
    const firstBody = first.body as AdminListResponse;
    const secondBody = second.body as AdminListResponse;
    const thirdBody = third.body as AdminListResponse;
    expect(firstBody.items).toHaveLength(10);
    expect(secondBody.items).toHaveLength(10);
    expect(thirdBody.items).toHaveLength(5);
    expect(firstBody.items[0].id).toBe('report-25');
    expect(
      new Set(
        [...firstBody.items, ...secondBody.items, ...thirdBody.items].map(
          (item) => item.id,
        ),
      ).size,
    ).toBe(25);
    expect(thirdBody.items[4].reporter_username).toBeNull();

    const filtered = await adminRequest(
      '/admin/reports?status=open&reason=spam&reported_username=target_user&reporter_username=reporter_2&from=2026-01-01T00%3A00%3A00Z&to=2026-01-10T00%3A00%3A00Z',
    ).expect(200);
    const filteredBody = filtered.body as AdminListResponse;
    expect(filteredBody.items).toHaveLength(1);
    expect(filteredBody.items[0].id).toBe('report-03');
    expect(filteredBody.total).toBe(1);
    expect(filteredBody.filters).toMatchObject({
      status: 'open',
      reason: 'spam',
      reported_username: 'target_user',
      reporter_username: 'reporter_2',
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-10T00:00:00Z',
    });
    expect(poolCalls.some((call) => call.sql.includes('ur.created_at <'))).toBe(
      true,
    );

    const halfOpen = await adminRequest(
      '/admin/reports?from=2026-01-01T00%3A00%3A00Z&to=2026-01-10T00%3A00%3A00Z',
    ).expect(200);
    expect((halfOpen.body as AdminListResponse).total).toBe(9);
  });

  it('rejects invalid filters, pagination, dates, and unknown query fields', async () => {
    for (const query of [
      '?page=0',
      '?limit=101',
      '?status=unknown',
      '?reason=unknown',
      '?from=nope',
      '?other=value',
    ]) {
      await adminRequest(`/admin/reports${query}`).expect(400);
    }
  });

  it('returns filtered list items without sensitive user data and bounds list queries', async () => {
    const response = await adminRequest(
      '/admin/reports?reporter_username=reporter_2&sort=oldest',
    ).expect(200);
    const body = response.body as AdminListResponse;
    expect(
      body.items.every((item) => item.reporter_username === 'reporter_2'),
    ).toBe(true);
    expect(
      poolCalls.filter((call) =>
        call.sql.startsWith('SELECT ur.id, reporter_user.username'),
      ),
    ).toHaveLength(1);
    expect(
      poolCalls.filter((call) =>
        call.sql.startsWith('SELECT COUNT(*) AS total'),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('email');
    expect(JSON.stringify(body)).not.toContain('password_hash');
  });

  it('returns null reporter, dangling context, triage aggregates, and 404 for unknown IDs', async () => {
    const response = await adminRequest('/admin/reports/report-01').expect(200);
    const body = response.body as AdminDetailResponse;
    expect(body.reporter_username).toBeNull();
    expect(body.reviewed_by_username).toBeNull();
    expect(body.context).toEqual({
      type: 'post',
      id: 'deleted-post',
      exists: false,
      title: null,
      content_excerpt: null,
      author_username: null,
    });
    expect(body).toMatchObject({
      open_reports_against_user: 12,
      total_reports_against_user: 25,
      prior_resolutions_against_user: [{ resolution: 'no_action', total: 10 }],
    });
    expect(JSON.stringify(body)).not.toContain('email');
    expect(JSON.stringify(body)).not.toContain('password_hash');
    await adminRequest('/admin/reports/missing-id').expect(404);
    await adminRequest('/admin/reports/bad.id').expect(400);
  });

  it('transitions report status and writes an audit record transactionally', async () => {
    const response = await adminPatch('/admin/reports/report-01')
      .send({
        status: 'resolved',
        resolution: 'user_suspended',
        resolution_note: '  reviewed  ',
      })
      .expect(200);

    expect(response.body).toMatchObject({
      id: 'report-01',
      status: 'resolved',
      resolution: 'user_suspended',
      resolution_note: 'reviewed',
      reviewed_by_username: 'admin',
    });
    expect(transactionCounts).toEqual({
      commits: 1,
      rollbacks: 0,
      releases: 1,
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toEqual([
      expect.any(String),
      'admin-id',
      'admin',
      'report_status_changed',
      'report',
      'report-01',
      JSON.stringify({
        from_status: 'open',
        to_status: 'resolved',
        resolution: 'user_suspended',
      }),
    ]);
    expect(poolCalls.some((call) => call.sql.includes('UPDATE users'))).toBe(
      false,
    );
    expect(
      poolCalls.some((call) => call.sql.includes('user_restrictions')),
    ).toBe(false);
  });

  it('rejects invalid transitions, repeats, conflicts of interest, and unknown body fields', async () => {
    await adminPatch('/admin/reports/report-01')
      .send({ status: 'rejected', resolution: 'no_action' })
      .expect(400);
    await adminPatch('/admin/reports/report-01')
      .send({
        status: 'resolved',
        resolution: 'no_action',
        reviewed_by: 'admin-id',
      })
      .expect(400);
    await adminPatch('/admin/reports/report-01')
      .send({ status: 'resolved' })
      .expect(400);

    const alreadyResolved = reports[12];
    await adminPatch(`/admin/reports/${alreadyResolved.id}`)
      .send({ status: 'rejected' })
      .expect(409);

    await request(app.getHttpServer())
      .patch('/admin/reports/report-01')
      .set('Authorization', 'Bearer target-token')
      .send({ status: 'under_review' })
      .expect(403);
    await adminPatch('/admin/reports/missing-id')
      .send({ status: 'under_review' })
      .expect(404);
    await adminPatch('/admin/reports/bad.id')
      .send({ status: 'under_review' })
      .expect(400);
    expect(auditRows).toHaveLength(0);
  });

  it('fails the report transition and rolls back if audit insertion fails', async () => {
    failAuditInsert = true;
    await adminPatch('/admin/reports/report-01')
      .send({ status: 'under_review' })
      .expect(500);

    expect(reports[0].status).toBe('open');
    expect(transactionCounts).toEqual({
      commits: 0,
      rollbacks: 1,
      releases: 1,
    });
  });

  describe('report targets', () => {
    const fixture = (overrides: Partial<ReportFixture>): ReportFixture => ({
      id: 'report-post',
      reporter_username: 'someone',
      reported_username: 'target_user',
      target_type: 'post',
      target_id: 'post-1',
      target_label: 'A post title',
      reason: 'spam',
      status: 'open',
      resolution: null,
      context_type: null,
      context_id: null,
      created_at: '2026-06-01T00:00:00.000Z',
      reviewed_at: null,
      resolution_note: null,
      withdrawn_at: null,
      assigned_to: null,
      assigned_to_username: null,
      assigned_at: null,
      ...overrides,
    });
    const listed = async (query: string) =>
      (await adminRequest(`/admin/reports${query}`).expect(200))
        .body as AdminListResponse;

    beforeEach(() => {
      reports.push(
        fixture({}),
        fixture({
          id: 'report-comment',
          target_type: 'comment',
          target_id: 'comment-1',
          target_label: 'A comment excerpt',
        }),
        fixture({
          id: 'report-community',
          reported_username: null,
          target_type: 'community',
          target_id: 'community-1',
          target_label: 'a-community',
        }),
      );
      targetContents.set('post-1', {
        title: 'A post title',
        content: 'The full post body',
        removed_at: new Date('2026-06-02T00:00:00.000Z'),
      });
      targetContents.set('comment-1', {
        title: null,
        content: 'The full comment body',
        removed_at: null,
      });
    });

    it('filters on target_type, with a matching total and echoed filter', async () => {
      const body = await listed('?target_type=post');
      expect(body.items.map((item) => item.id)).toEqual(['report-post']);
      expect(body.total).toBe(1);
      expect(body.filters.target_type).toBe('post');
    });

    it('returns every target type in one ordered stream without the filter', async () => {
      const body = await listed('?limit=100');
      expect(body.total).toBe(28);
      expect(new Set(body.items.map((item) => item.target_type))).toEqual(
        new Set(['user', 'post', 'comment', 'community']),
      );
      const order = body.items.map((item) => item.created_at);
      expect(order).toEqual([...order].sort().reverse());
      expect(body.filters.target_type).toBeNull();
    });

    it('rejects an unknown target_type with 400', async () => {
      await adminRequest('/admin/reports?target_type=account').expect(400);
    });

    it('lists the target and its label, with a null account for a community', async () => {
      const body = await listed('?target_type=community');
      expect(body.items[0]).toMatchObject({
        target_type: 'community',
        target_id: 'community-1',
        target_label: 'a-community',
        reported_username: null,
      });
    });

    it('matches content reports on reported_username, never community ones', async () => {
      const body = await listed('?reported_username=target_user&limit=100');
      const ids = body.items.map((item) => item.id);
      expect(ids).toContain('report-post');
      expect(ids).toContain('report-comment');
      expect(ids).not.toContain('report-community');
    });

    it('returns enough of a content target to judge it', async () => {
      const post = await adminRequest('/admin/reports/report-post').expect(200);
      expect(post.body).toMatchObject({
        target_type: 'post',
        target_id: 'post-1',
        target_label: 'A post title',
        target_content: {
          title: 'A post title',
          content: 'The full post body',
          removed: true,
        },
      });
      const comment = await adminRequest(
        '/admin/reports/report-comment',
      ).expect(200);
      expect(comment.body).toMatchObject({
        target_content: {
          title: null,
          content: 'The full comment body',
          removed: false,
        },
      });
    });

    it('returns no content and no account counts for a community', async () => {
      const response = await adminRequest(
        '/admin/reports/report-community',
      ).expect(200);
      expect(response.body).toMatchObject({
        reported_username: null,
        target_content: null,
        open_reports_against_user: 0,
        total_reports_against_user: 0,
        prior_resolutions_against_user: [],
      });
    });

    it('keeps a report whose target is then deleted, with a null label', async () => {
      const post = reports.find((report) => report.id === 'report-post')!;
      post.target_label = null;
      targetContents.delete('post-1');

      const body = await listed('?target_type=post');
      expect(body.items[0]).toMatchObject({
        id: 'report-post',
        target_id: 'post-1',
        target_label: null,
      });
      const detail = await adminRequest('/admin/reports/report-post').expect(
        200,
      );
      expect(detail.body).toMatchObject({
        target_label: null,
        target_content: null,
      });
    });

    it.each(['report-post', 'report-comment', 'report-community'])(
      'transitions %s, telling the reporter { status } only',
      async (id) => {
        await adminPatch(`/admin/reports/${id}`)
          .send({
            status: 'resolved',
            resolution: 'no_action',
            resolution_note: 'Internal note',
          })
          .expect(200);
        expect(notificationRows).toHaveLength(1);
        const text = JSON.stringify(notificationRows[0]);
        expect(JSON.parse(String(notificationRows[0].metadata))).toEqual({
          status: 'resolved',
        });
        expect(text).not.toMatch(/Internal note|no_action|admin-id/);
      },
    );

    it('serialises no email, password hash, token or session', async () => {
      const bodies = [
        (await adminRequest('/admin/reports?limit=100').expect(200)).text,
        (await adminRequest('/admin/reports/report-post').expect(200)).text,
        (await adminRequest('/admin/reports/report-community').expect(200))
          .text,
      ];
      for (const text of bodies) {
        expect(text).not.toMatch(/email|password_hash|session|token/i);
      }
    });
  });

  describe('reporter notifications', () => {
    const reporterInbox = () =>
      request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', 'Bearer reporter-token')
        .expect(200);

    it('tells the reporter the outcome and nothing else', async () => {
      await adminPatch('/admin/reports/report-02')
        .send({
          status: 'resolved',
          resolution: 'user_banned',
          resolution_note: 'internal: repeat offender',
        })
        .expect(200);

      expect(notificationRows).toHaveLength(1);
      expect(notificationRows[0]).toMatchObject({
        recipient_id: 'reporter-id',
        type: 'report_resolved',
        actor_id: null,
        subject_type: 'report',
        subject_id: 'report-02',
        community_id: null,
      });
      expect(JSON.parse(String(notificationRows[0].metadata))).toEqual({
        status: 'resolved',
      });

      const inbox = await reporterInbox();
      const body = inbox.body as { total: number; items: unknown[] };
      expect(body.total).toBe(1);
      expect(body.items[0]).toMatchObject({
        type: 'report_resolved',
        actor_username: null,
        subject_id: 'report-02',
        metadata: { status: 'resolved' },
      });
      const serialised = JSON.stringify(inbox.body);
      for (const leaked of [
        'resolution',
        'user_banned',
        'repeat offender',
        'reviewed_by',
        'admin',
        'target',
        'other_target',
      ]) {
        expect(serialised).not.toContain(leaked);
      }
    });

    it('writes nothing for under_review, a refused repeat, or a deleted reporter', async () => {
      await adminPatch('/admin/reports/report-02')
        .send({ status: 'under_review' })
        .expect(200);
      await adminPatch('/admin/reports/report-02')
        .send({ status: 'under_review' })
        .expect(409);
      await adminPatch('/admin/reports/report-01')
        .send({ status: 'rejected' })
        .expect(200);

      expect(notificationRows).toEqual([]);
      expect(auditRows).toHaveLength(2);
    });

    it('rolls the status change back if the notification cannot be written', async () => {
      failNotificationInsert = true;

      await adminPatch('/admin/reports/report-02')
        .send({ status: 'rejected' })
        .expect(500);

      expect(reports[1].status).toBe('open');
      expect(notificationRows).toEqual([]);
      expect(transactionCounts).toEqual({
        commits: 0,
        rollbacks: 1,
        releases: 1,
      });
    });
  });

  describe('withdrawn reports', () => {
    const withdraw = (id: string) => {
      reports.find((row) => row.id === id)!.withdrawn_at =
        '2026-10-27T08:00:00.000Z';
    };
    const ids = (body: AdminListResponse) => body.items.map((item) => item.id);
    const queue = async (query = '') =>
      (await adminRequest(`/admin/reports?limit=100${query}`).expect(200))
        .body as AdminListResponse;

    it('drops a report from the default queue once its reporter withdraws it', async () => {
      const before = await queue();
      expect(ids(before)).toContain('report-03');
      expect(before.total).toBe(25);
      expect(before.filters.withdrawn).toBe('exclude');

      withdraw('report-03');

      const after = await queue();
      expect(ids(after)).not.toContain('report-03');
      expect(after.total).toBe(24);
      expect((await queue('&status=open')).total).toBe(11);
    });

    it('lists it again under withdrawn=include, and alone under withdrawn=only', async () => {
      withdraw('report-03');

      const included = await queue('&withdrawn=include');
      expect(included.total).toBe(25);
      expect(
        included.items.find((item) => item.id === 'report-03'),
      ).toMatchObject({ withdrawn_at: '2026-10-27T08:00:00.000Z' });
      expect(included.filters.withdrawn).toBe('include');

      const only = await queue('&withdrawn=only');
      expect(ids(only)).toEqual(['report-03']);
      expect(only.total).toBe(1);
    });

    it('answers an unknown withdrawn value with 400', async () => {
      await adminRequest('/admin/reports?withdrawn=true').expect(400);
    });

    it('still returns a withdrawn report by id, marked as withdrawn', async () => {
      withdraw('report-03');
      const detail = await adminRequest('/admin/reports/report-03').expect(200);
      expect(detail.body).toMatchObject({
        id: 'report-03',
        status: 'open',
        withdrawn_at: '2026-10-27T08:00:00.000Z',
      });
      const standing = await adminRequest('/admin/reports/report-05').expect(
        200,
      );
      expect(standing.body).toMatchObject({ withdrawn_at: null });
    });

    it.each([
      { status: 'under_review' },
      { status: 'rejected' },
      { status: 'resolved', resolution: 'no_action' },
    ])(
      'refuses %o on a withdrawn report with 409, writing nothing',
      async (body) => {
        withdraw('report-03');
        await adminPatch('/admin/reports/report-03').send(body).expect(409);

        expect(reports.find((row) => row.id === 'report-03')).toMatchObject({
          status: 'open',
          reviewed_at: null,
          resolution: null,
        });
        expect(auditRows).toHaveLength(0);
        expect(notificationRows).toHaveLength(0);
        expect(transactionCounts).toEqual({
          commits: 0,
          rollbacks: 1,
          releases: 1,
        });
      },
    );

    it('still transitions a report that was not withdrawn', async () => {
      withdraw('report-03');
      await adminPatch('/admin/reports/report-05')
        .send({ status: 'under_review' })
        .expect(200);
    });
  });

  describe('assignment', () => {
    const as = (token: string) => ({
      assign: (id: string, body?: object) => {
        const call = request(app.getHttpServer())
          .post(`/admin/reports/${id}/assign`)
          .set('Authorization', `Bearer ${token}`);
        return body === undefined ? call : call.send(body);
      },
      unassign: (id: string) =>
        request(app.getHttpServer())
          .delete(`/admin/reports/${id}/assign`)
          .set('Authorization', `Bearer ${token}`),
      list: async (query: string) =>
        (
          await request(app.getHttpServer())
            .get(`/admin/reports?limit=100${query}`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200)
        ).body as AdminListResponse & {
          items: Array<ReportFixture & Record<string, unknown>>;
        },
    });
    const admin = as('admin-token');
    const second = as('admin2-token');
    const report = (id: string) => reports.find((row) => row.id === id)!;
    const actions = () => auditRows.map((row) => row[3]);
    const metadataOf = (index: number) =>
      JSON.parse(String(auditRows[index][6])) as Record<string, unknown>;
    // Nothing about the report or the log moved.
    const unchanged = (id: string) => {
      expect(report(id)).toMatchObject({
        assigned_to: null,
        assigned_to_username: null,
        assigned_at: null,
      });
      expect(auditRows).toHaveLength(0);
    };

    describe('POST /admin/reports/:id/assign', () => {
      it('assigns to the caller when no body is sent, without changing status', async () => {
        const response = await admin.assign('report-02').expect(200);

        expect(response.body).toMatchObject({
          id: 'report-02',
          status: 'open',
          assigned_to_username: 'admin',
          assigned_at: '2026-10-27T09:00:00.000Z',
          reviewed_by_username: null,
        });
        expect(report('report-02').status).toBe('open');
        expect(actions()).toEqual(['report_assigned']);
        expect(auditRows[0].slice(4, 6)).toEqual(['report', 'report-02']);
        expect(metadataOf(0)).toEqual({ assignee_username: 'admin' });
        expect(transactionCounts).toEqual({
          commits: 1,
          rollbacks: 0,
          releases: 1,
        });
      });

      it('assigns to a named administrator, and an empty body means the caller', async () => {
        await admin
          .assign('report-02', { username: 'second_admin' })
          .expect(200);
        expect(report('report-02').assigned_to).toBe('admin2-id');
        await second.assign('report-04', {}).expect(200);
        expect(report('report-04').assigned_to).toBe('admin2-id');
      });

      it('assigns an under_review report', async () => {
        report('report-02').status = 'under_review';
        await admin.assign('report-02').expect(200);
        expect(report('report-02').status).toBe('under_review');
      });

      it('answers an unknown or deleted username with 404, writing nothing', async () => {
        await admin
          .assign('report-02', { username: 'nobody_here' })
          .expect(404);
        await admin.assign('report-02', { username: 'gone_admin' }).expect(404);
        unchanged('report-02');
      });

      // An owner who cannot open the report would make assignment useless.
      it('refuses an assignee who is not an administrator with 400, writing nothing', async () => {
        await admin.assign('report-02', { username: 'plain_user' }).expect(400);
        roles.set('user-id', 'moderator');
        await admin.assign('report-02', { username: 'plain_user' }).expect(400);
        unchanged('report-02');
      });

      it.each([
        { username: 'ab' },
        { username: 'has-hyphen' },
        { username: 'x'.repeat(51) },
        { username: 42 },
        { assignee_id: 'admin2-id' },
        { username: 'second_admin', status: 'under_review' },
      ])('answers the body %o with 400', async (body) => {
        await admin.assign('report-02', body).expect(400);
        unchanged('report-02');
      });

      describe('conflicts of interest', () => {
        beforeEach(() => {
          roles.set('reporter-id', 'admin');
          roles.set('target-id', 'admin');
        });

        it('refuses an assignee who filed the report with 403', async () => {
          await admin
            .assign('report-02', { username: 'reporter_admin' })
            .expect(403);
          unchanged('report-02');
        });

        it('refuses an assignee who is the reported user with 403', async () => {
          await admin
            .assign('report-02', { username: 'target_user' })
            .expect(403);
          unchanged('report-02');
        });

        it('refuses self-assignment by a party to the report with 403', async () => {
          for (const token of ['reporter-token', 'target-token']) {
            await as(token).assign('report-02').expect(403);
          }
          unchanged('report-02');
        });

        it('refuses a party handing their own report to someone else with 403', async () => {
          await as('reporter-token')
            .assign('report-02', { username: 'admin' })
            .expect(403);
          unchanged('report-02');
        });
      });

      it.each(['resolved', 'rejected'])(
        'refuses a %s report with 409, writing nothing',
        async (status) => {
          report('report-02').status = status;
          await admin.assign('report-02').expect(409);
          unchanged('report-02');
        },
      );

      it('refuses a withdrawn report with 409, writing nothing', async () => {
        report('report-02').withdrawn_at = '2026-10-27T08:00:00.000Z';
        await admin.assign('report-02').expect(409);
        unchanged('report-02');
      });

      it('hands over on re-assignment, and treats a repeat as a no-op', async () => {
        await admin.assign('report-02').expect(200);
        const handedOver = await admin
          .assign('report-02', { username: 'second_admin' })
          .expect(200);
        expect(handedOver.body).toMatchObject({
          assigned_to_username: 'second_admin',
          assigned_at: '2026-10-27T09:01:00.000Z',
        });

        const repeated = await admin
          .assign('report-02', { username: 'second_admin' })
          .expect(200);
        expect(repeated.body).toMatchObject({
          assigned_to_username: 'second_admin',
          assigned_at: '2026-10-27T09:01:00.000Z',
        });
        expect(actions()).toEqual(['report_assigned', 'report_assigned']);
        expect(metadataOf(1)).toEqual({ assignee_username: 'second_admin' });
      });

      it('rolls the assignment back when the audit entry cannot be written', async () => {
        failAuditInsert = true;
        await admin.assign('report-02').expect(500);
        expect(report('report-02').assigned_to).toBeNull();
        expect(transactionCounts).toEqual({
          commits: 0,
          rollbacks: 1,
          releases: 1,
        });
      });
    });

    describe('DELETE /admin/reports/:id/assign', () => {
      it('clears both columns, records who was dropped, and answers 204', async () => {
        await second.assign('report-02').expect(200);
        const response = await admin.unassign('report-02').expect(204);

        expect(response.text).toBe('');
        expect(report('report-02')).toMatchObject({
          assigned_to: null,
          assigned_at: null,
          status: 'open',
        });
        expect(actions()).toEqual(['report_assigned', 'report_unassigned']);
        expect(auditRows[1][2]).toBe('admin');
        expect(metadataOf(1)).toEqual({ assignee_username: 'second_admin' });
      });

      it('answers an unassigned report with 204 and writes nothing', async () => {
        await admin.unassign('report-02').expect(204);
        await admin.unassign('report-02').expect(204);
        unchanged('report-02');
      });

      it.each(['resolved', 'rejected'])(
        'refuses a %s report with 409',
        async (status) => {
          await admin.assign('report-02').expect(200);
          report('report-02').status = status;
          await admin.unassign('report-02').expect(409);
          expect(report('report-02').assigned_to).toBe('admin-id');
          expect(actions()).toEqual(['report_assigned']);
        },
      );

      it('refuses a withdrawn report with 409', async () => {
        report('report-02').withdrawn_at = '2026-10-27T08:00:00.000Z';
        await admin.unassign('report-02').expect(409);
      });

      it('refuses a party to the report with 403', async () => {
        roles.set('reporter-id', 'admin');
        await admin.assign('report-02').expect(200);
        await as('reporter-token').unassign('report-02').expect(403);
        expect(report('report-02').assigned_to).toBe('admin-id');
      });

      it('rolls the unassignment back when the audit entry cannot be written', async () => {
        await admin.assign('report-02').expect(200);
        failAuditInsert = true;
        await admin.unassign('report-02').expect(500);
        expect(report('report-02').assigned_to).toBe('admin-id');
      });
    });

    it('guards both routes like every admin route, and validates the id', async () => {
      for (const [method, path] of [
        ['post', '/admin/reports/report-02/assign'],
        ['delete', '/admin/reports/report-02/assign'],
      ] as const) {
        await request(app.getHttpServer())[method](path).expect(401);
        await request(app.getHttpServer())
          [method](path)
          .set('Authorization', 'Bearer user-token')
          .expect(403);
      }
      await admin.assign('no-such-report').expect(404);
      await admin.unassign('no-such-report').expect(404);
      await admin.assign('x'.repeat(37)).expect(400);
      await admin.unassign('bad.id').expect(400);
      expect(auditRows).toHaveLength(0);
    });

    it('releases the connection on every path of both routes', async () => {
      await admin.assign('report-02').expect(200);
      await admin.assign('report-02').expect(200);
      await admin.assign('report-04', { username: 'plain_user' }).expect(400);
      await admin.assign('no-such-report').expect(404);
      report('report-06').status = 'resolved';
      await admin.assign('report-06').expect(409);
      await admin.unassign('report-02').expect(204);
      await admin.unassign('report-02').expect(204);
      await admin.unassign('report-06').expect(409);
      expect(transactionCounts.releases).toBe(8);
    });

    it('leaves PATCH transitions exactly as before, and keeps the assignee', async () => {
      await second.assign('report-02').expect(200);
      await adminPatch('/admin/reports/report-02')
        .send({ status: 'resolved', resolution: 'no_action' })
        .expect(200);
      expect(report('report-02')).toMatchObject({
        status: 'resolved',
        assigned_to: 'admin2-id',
      });
      // Assignment is no permission: an unassigned or someone else's report
      // transitions as it always did.
      await adminPatch('/admin/reports/report-04')
        .send({ status: 'under_review' })
        .expect(200);
      await adminPatch('/admin/reports/report-04')
        .send({ status: 'under_review' })
        .expect(409);
    });

    describe('the queue', () => {
      beforeEach(async () => {
        await admin.assign('report-02').expect(200);
        await admin.assign('report-03').expect(200);
        await second.assign('report-04').expect(200);
      });

      it('lists only the caller’s reports under assigned=me', async () => {
        const mine = await admin.list('&assigned=me');
        expect(mine.items.map((item) => item.id)).toEqual([
          'report-03',
          'report-02',
        ]);
        expect(mine.total).toBe(2);
        expect(mine.filters).toMatchObject({
          assigned: 'me',
          assigned_to: null,
        });

        const theirs = await second.list('&assigned=me');
        expect(theirs.items.map((item) => item.id)).toEqual(['report-04']);
      });

      it('lists only unassigned reports under assigned=none', async () => {
        const none = await admin.list('&assigned=none');
        expect(none.total).toBe(22);
        expect(
          none.items.every((item) => item.assigned_to_username === null),
        ).toBe(true);
        expect(none.items.map((item) => item.id)).not.toContain('report-02');
      });

      it('filters on the assignee by username', async () => {
        const body = await admin.list('&assigned_to=second_admin');
        expect(body.items.map((item) => item.id)).toEqual(['report-04']);
        expect(body.filters.assigned_to).toBe('second_admin');
      });

      it('lists everything under the default assigned=any', async () => {
        const body = await admin.list('');
        expect(body.total).toBe(25);
        expect(body.filters.assigned).toBe('any');
        expect(
          body.items.find((item) => item.id === 'report-04'),
        ).toMatchObject({
          assigned_to_username: 'second_admin',
          assigned_at: '2026-10-27T09:02:00.000Z',
        });
      });

      it.each(['?assigned=mine', '?assigned=ME', '?assigned_to=has-hyphen'])(
        'answers %s with 400',
        async (query) => {
          await adminRequest(`/admin/reports${query}`).expect(400);
        },
      );

      // assigned_to went to NULL with the account, or the join found an
      // anonymised one: either way the report reads as unassigned.
      it('renders a deleted assignee as unassigned, without throwing', async () => {
        Object.assign(report('report-05'), {
          assigned_to: 'gone-admin-id',
          assigned_to_username: null,
          assigned_at: null,
        });
        const listed = await admin.list('');
        expect(
          listed.items.find((item) => item.id === 'report-05'),
        ).toMatchObject({ assigned_to_username: null, assigned_at: null });
        const detail = await adminRequest('/admin/reports/report-05').expect(
          200,
        );
        expect(detail.body).toMatchObject({
          assigned_to_username: null,
          assigned_at: null,
        });
      });
    });
  });
});
