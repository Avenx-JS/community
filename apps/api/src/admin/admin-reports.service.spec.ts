import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from './audit-log.service';
import { ListReportsDto } from './dto/list-reports.dto';
import { UpdateReportStatusDto } from './dto/update-report-status.dto';
import { AdminReportsService } from './admin-reports.service';

describe('AdminReportsService', () => {
  let service: AdminReportsService;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let listRows: Array<Record<string, unknown>>;
  let count = 0;
  let detailRow: Record<string, unknown> | undefined;
  let contextRow: Record<string, unknown> | undefined;
  let targetContentRow: Record<string, unknown> | undefined;
  let resolutionRows: Array<Record<string, unknown>>;
  let transitionRow:
    | {
        id: string;
        reporter_id: string | null;
        reported_user_id: string | null;
        status: 'open' | 'under_review' | 'resolved' | 'rejected';
        withdrawn_at?: string | null;
      }
    | undefined;
  let updateAffectedRows: number;
  let transaction: { commits: number; rollbacks: number; releases: number };
  let auditEntries: Array<{ connection: unknown; entry: unknown }>;
  let failAudit: boolean;
  let notificationEntries: Array<{ connection: unknown; entry: unknown }>;
  let failNotification: boolean;
  let usedConnection: unknown;

  beforeEach(async () => {
    calls = [];
    listRows = [];
    count = 0;
    detailRow = undefined;
    contextRow = undefined;
    targetContentRow = undefined;
    resolutionRows = [];
    transitionRow = {
      id: 'report-1',
      reporter_id: 'reporter-id',
      reported_user_id: 'target-id',
      status: 'open',
    };
    updateAffectedRows = 1;
    transaction = { commits: 0, rollbacks: 0, releases: 0 };
    auditEntries = [];
    failAudit = false;
    notificationEntries = [];
    failNotification = false;
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        if (
          sql.startsWith('SELECT ur.id, reporter_user.username') &&
          !sql.includes('ur.description')
        ) {
          // MySQL always returns the column; fixtures that predate it stand.
          return Promise.resolve([
            listRows.map((row) => ({ withdrawn_at: null, ...row })),
            [],
          ]);
        }
        if (sql.startsWith('SELECT COUNT(*) AS total')) {
          return Promise.resolve([[{ total: count }], []]);
        }
        if (
          sql.startsWith('SELECT ur.id, reporter_user.username') &&
          sql.includes('ur.description')
        ) {
          return Promise.resolve([
            detailRow ? [{ withdrawn_at: null, ...detailRow }] : [],
            [],
          ]);
        }
        if (
          sql.startsWith('SELECT ') &&
          sql.includes('context.content AS content')
        ) {
          return Promise.resolve([contextRow ? [contextRow] : [], []]);
        }
        if (/^SELECT (title|NULL AS title), content, removed_at/.test(sql)) {
          return Promise.resolve([
            targetContentRow ? [targetContentRow] : [],
            [],
          ]);
        }
        if (sql.includes('AS open_reports_against_user')) {
          return Promise.resolve([
            [
              {
                open_reports_against_user: 3,
                total_reports_against_user: 7,
              },
            ],
            [],
          ]);
        }
        if (sql.startsWith('SELECT resolution, COUNT(*)')) {
          return Promise.resolve([resolutionRows, []]);
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => {
        transaction.commits += 1;
        return Promise.resolve();
      },
      rollback: () => {
        transaction.rollbacks += 1;
        return Promise.resolve();
      },
      release: () => {
        transaction.releases += 1;
      },
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT id, reporter_id, reported_user_id')) {
          return Promise.resolve([
            transitionRow ? [{ withdrawn_at: null, ...transitionRow }] : [],
            [],
          ]);
        }
        if (sql.startsWith('UPDATE user_reports')) {
          if (updateAffectedRows === 1 && transitionRow) {
            const [status] = values as [
              'open' | 'under_review' | 'resolved' | 'rejected',
            ];
            transitionRow.status = status;
            if (detailRow) {
              detailRow.status = status;
              detailRow.resolution = values[1];
              detailRow.resolution_note = values[2];
              detailRow.reviewed_by_username = 'admin';
              detailRow.reviewed_at = '2026-10-26T12:00:00Z';
            }
          }
          return Promise.resolve([{ affectedRows: updateAffectedRows }, []]);
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminReportsService,
        {
          provide: MYSQL_POOL,
          useValue: {
            ...pool,
            getConnection: () => {
              usedConnection = connection;
              return Promise.resolve(connection);
            },
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            record: (onConnection: unknown, entry: unknown) => {
              notificationEntries.push({ connection: onConnection, entry });
              return failNotification
                ? Promise.reject(new Error('Notification insert failed'))
                : Promise.resolve();
            },
          },
        },
        {
          provide: AuditLogService,
          useValue: {
            record: (usedConnection: unknown, entry: unknown) => {
              auditEntries.push({ connection: usedConnection, entry });
              return failAudit
                ? Promise.reject(new Error('Audit insert failed'))
                : Promise.resolve();
            },
          },
        },
      ],
    }).compile();
    service = module.get<AdminReportsService>(AdminReportsService);
  });

  it('applies each filter to both list and count with matching parameters', async () => {
    const query = {
      status: 'open',
      reason: 'spam',
      reported_username: 'target_user',
      reporter_username: 'reporter',
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
      page: 2,
      limit: 10,
      sort: 'new',
    } as ListReportsDto;
    await service.findAll(query);

    const list = calls[0];
    const countQuery = calls[1];
    const where = list.sql
      .slice(list.sql.indexOf(' WHERE '), list.sql.indexOf(' ORDER BY'))
      .trim();
    expect(countQuery.sql).toContain(where);
    expect(list.values.slice(0, 6)).toEqual(countQuery.values);
    expect(countQuery.values).toEqual([
      'open',
      'spam',
      'target_user',
      'reporter',
      '2026-01-01 00:00:00',
      '2026-02-01 00:00:00',
    ]);
    expect(list.sql).toContain('created_at DESC, ur.id DESC');
  });

  describe('report targets', () => {
    // A community report has no reported account, and target_id has no foreign
    // key, so an inner join on either would lose a report.
    it('reads the queue with left joins only, in both the page and its count', async () => {
      await service.findAll({} as ListReportsDto);
      const [list, countQuery] = calls;

      for (const { sql } of [list, countQuery]) {
        expect(sql).not.toContain('INNER JOIN');
        expect(sql).toContain(
          'LEFT JOIN users reported_user ON reported_user.id = ur.reported_user_id',
        );
      }
      for (const [alias, table, type] of [
        ['target_user', 'users', 'user'],
        ['target_post', 'posts', 'post'],
        ['target_comment', 'comments', 'comment'],
        ['target_community', 'communities', 'community'],
      ]) {
        expect(list.sql).toContain(`LEFT JOIN ${table} ${alias}`);
        expect(list.sql).toContain(
          `ON ur.target_type = '${type}' AND ${alias}.id = ur.target_id`,
        );
      }
    });

    it('applies target_type to the page and its count, and reports the filter', async () => {
      const result = await service.findAll({
        target_type: 'post',
        reason: 'spam',
      } as ListReportsDto);
      const [list, countQuery] = calls;
      for (const { sql } of [list, countQuery]) {
        expect(sql).toContain('ur.target_type = ?');
      }
      expect(countQuery.values).toEqual(['spam', 'post']);
      expect(list.values.slice(0, 2)).toEqual(['spam', 'post']);
      expect(result.filters.target_type).toBe('post');
    });

    it('applies no target filter by default', async () => {
      const result = await service.findAll({} as ListReportsDto);
      expect(calls[1].sql).not.toContain('ur.target_type = ?');
      expect(result.filters.target_type).toBeNull();
    });

    it('still reads reported_username through the reported account, for content reports too', async () => {
      await service.findAll({
        reported_username: 'content_author',
        target_type: 'comment',
      } as ListReportsDto);
      expect(calls[0].sql).toContain('reported_user.username = ?');
      expect(calls[1].values).toEqual(['content_author', 'comment']);
    });

    it.each([
      ['user', 'someone', 'someone'],
      ['post', 'p-1', 'A post title'],
      ['comment', 'm-1', 'A comment excerpt'],
      ['community', 'c-1', 'a-community'],
      ['post', 'gone', null],
    ])(
      'passes through the label of a %s target (%s)',
      async (target_type, target_id, target_label) => {
        listRows = [
          {
            id: 'r1',
            reporter_username: 'reporter',
            reported_username: target_type === 'community' ? null : 'someone',
            target_type,
            target_id,
            target_label,
            reason: 'spam',
            status: 'open',
            resolution: null,
            context_type: null,
            context_id: null,
            created_at: '2026-10-25T10:00:00Z',
            reviewed_at: null,
          },
        ];
        count = 1;
        const { items } = await service.findAll({} as ListReportsDto);
        expect(items[0]).toMatchObject({
          target_type,
          target_id,
          target_label,
        });
      },
    );

    it('builds the label per kind, excerpting a comment', async () => {
      await service.findAll({} as ListReportsDto);
      const { sql } = calls[0];
      expect(sql).toContain("WHEN 'user' THEN target_user.username");
      expect(sql).toContain("WHEN 'post' THEN target_post.title");
      expect(sql).toContain(
        "WHEN 'comment' THEN LEFT(target_comment.content, 100)",
      );
      expect(sql).toContain("WHEN 'community' THEN target_community.name");
    });

    const detail = (overrides: Record<string, unknown>) => ({
      id: 'report-1',
      reporter_username: 'reporter',
      reported_user_id: 'author-id',
      reported_username: 'author',
      target_type: 'post',
      target_id: 'p-1',
      target_label: 'A title',
      reason: 'spam',
      status: 'open',
      resolution: null,
      context_type: null,
      context_id: null,
      created_at: '2026-10-25T10:00:00Z',
      reviewed_at: null,
      description: null,
      resolution_note: null,
      reviewed_by_username: null,
      ...overrides,
    });

    it('returns a post target in full, and whether it was removed', async () => {
      detailRow = detail({});
      targetContentRow = {
        title: 'A title',
        content: 'y'.repeat(2000),
        removed_at: '2026-10-26T00:00:00Z',
      };
      const result = await service.findOne('report-1');
      expect(result.target_content).toEqual({
        title: 'A title',
        content: 'y'.repeat(2000),
        removed: true,
      });
    });

    it('returns a comment target with no title', async () => {
      detailRow = detail({ target_type: 'comment', target_id: 'm-1' });
      targetContentRow = { title: null, content: 'Body', removed_at: null };
      const result = await service.findOne('report-1');
      expect(result.target_content).toEqual({
        title: null,
        content: 'Body',
        removed: false,
      });
      expect(
        calls.some(({ sql }) => sql.includes('FROM comments WHERE id = ?')),
      ).toBe(true);
    });

    it('returns a null label and no content for a missing target, without throwing', async () => {
      detailRow = detail({ target_label: null });
      const result = await service.findOne('report-1');
      expect(result.target_label).toBeNull();
      expect(result.target_content).toBeNull();
    });

    it.each(['user', 'community'])(
      'does not look for content on a %s target',
      async (target_type) => {
        detailRow = detail({ target_type });
        const result = await service.findOne('report-1');
        expect(result.target_content).toBeNull();
        expect(calls.some(({ sql }) => sql.includes('removed_at'))).toBe(false);
      },
    );

    it('skips the account counts for a report with no account', async () => {
      detailRow = detail({
        target_type: 'community',
        reported_user_id: null,
        reported_username: null,
      });
      const result = await service.findOne('report-1');
      expect(result).toMatchObject({
        reported_username: null,
        open_reports_against_user: 0,
        total_reports_against_user: 0,
        prior_resolutions_against_user: [],
      });
      expect(
        calls.some(({ sql }) => sql.includes('reported_user_id = ?')),
      ).toBe(false);
    });

    // Without this, the guard is NULL for a community report, the update
    // matches no row, and the admin gets a false "changed concurrently".
    it('keeps the transition guard true for a report with no account', async () => {
      transitionRow = {
        id: 'report-1',
        reporter_id: 'reporter-id',
        reported_user_id: null,
        status: 'open',
      };
      detailRow = detail({
        target_type: 'community',
        reported_user_id: null,
        reported_username: null,
      });

      await service.updateStatus(
        'report-1',
        { status: 'rejected' },
        'admin-id',
      );

      const update = calls.find(({ sql }) =>
        sql.startsWith('UPDATE user_reports'),
      );
      expect(update?.sql).toContain(
        '(reported_user_id IS NULL OR reported_user_id <> ?)',
      );
      expect(notificationEntries).toHaveLength(1);
      expect(notificationEntries[0].entry).toMatchObject({
        metadata: { status: 'rejected' },
      });
    });
  });

  it('orders oldest first with an id tiebreaker and returns the filtered envelope', async () => {
    listRows = [
      {
        id: 'r1',
        reporter_username: null,
        reported_username: 'target',
        reason: 'spam',
        status: 'open',
        resolution: null,
        context_type: null,
        context_id: null,
        created_at: '2026-10-25T10:00:00Z',
        reviewed_at: null,
      },
    ];
    count = 1;

    const result = await service.findAll({ sort: 'oldest' } as ListReportsDto);

    expect(calls[0].sql).toContain('created_at ASC, ur.id ASC');
    expect(result).toEqual({
      items: [
        {
          id: 'r1',
          reporter_username: null,
          reported_username: 'target',
          reason: 'spam',
          status: 'open',
          resolution: null,
          has_context: false,
          created_at: '2026-10-25T10:00:00.000Z',
          reviewed_at: null,
          withdrawn_at: null,
        },
      ],
      page: 1,
      limit: 20,
      total: 1,
      filters: {
        status: null,
        reason: null,
        target_type: null,
        reported_username: null,
        reporter_username: null,
        withdrawn: 'exclude',
        from: null,
        to: null,
        sort: 'oldest',
      },
    });
  });

  it('interprets date-only ISO filters as UTC', async () => {
    await service.findAll({
      from: '2026-01-01T00:00:00',
      to: '2026-01-02T00:00:00',
    } as ListReportsDto);

    expect(calls[0].values.slice(0, 2)).toEqual([
      '2026-01-01 00:00:00',
      '2026-01-02 00:00:00',
    ]);
  });

  it('uses exactly two queries for a list regardless of number of results', async () => {
    listRows = Array.from({ length: 100 }, (_, index) => ({
      id: `r${index}`,
      reporter_username: `reporter${index}`,
      reported_username: 'target',
      reason: 'spam',
      status: 'open',
      resolution: null,
      context_type: null,
      context_id: null,
      created_at: '2026-10-25T10:00:00Z',
      reviewed_at: null,
    }));

    const result = await service.findAll({ limit: 100 } as ListReportsDto);

    expect(result.items).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it('maps detail context, nullable users, aggregates, and grouped resolutions', async () => {
    detailRow = {
      id: 'report-1',
      reporter_username: null,
      reported_username: 'target',
      reported_user_id: 'target-id',
      reason: 'harassment',
      status: 'resolved',
      resolution: 'no_action',
      context_type: 'post',
      context_id: 'post-1',
      description: 'detail',
      resolution_note: 'reviewed',
      reviewed_by_username: null,
      created_at: '2026-10-25T10:00:00Z',
      reviewed_at: null,
    };
    contextRow = {
      title: 'Post title',
      content: 'x'.repeat(501),
      author_username: 'target',
    };
    resolutionRows = [
      { resolution: 'no_action', total: 2 },
      { resolution: 'content_removed', total: '1' },
    ];

    const result = await service.findOne('report-1');

    expect(result.reporter_username).toBeNull();
    expect(result.reviewed_by_username).toBeNull();
    expect(result.context).toMatchObject({
      type: 'post',
      id: 'post-1',
      exists: true,
      title: 'Post title',
      content_excerpt: 'x'.repeat(500),
      author_username: 'target',
    });
    expect(result.open_reports_against_user).toBe(3);
    expect(result.total_reports_against_user).toBe(7);
    expect(result.prior_resolutions_against_user).toEqual([
      { resolution: 'no_action', total: 2 },
      { resolution: 'content_removed', total: 1 },
    ]);
  });

  it('returns null context when absent and exists false for a dangling reference', async () => {
    detailRow = {
      id: 'report-1',
      reporter_username: 'reporter',
      reported_username: 'target',
      reported_user_id: 'target-id',
      reason: 'spam',
      status: 'open',
      resolution: null,
      context_type: null,
      context_id: null,
      description: null,
      resolution_note: null,
      reviewed_by_username: null,
      created_at: '2026-10-25T10:00:00Z',
      reviewed_at: null,
    };
    const withoutContext = await service.findOne('report-1');
    expect(withoutContext.context).toBeNull();

    detailRow.context_type = 'comment';
    detailRow.context_id = 'deleted-comment';
    const dangling = await service.findOne('report-1');
    expect(dangling.context).toEqual({
      type: 'comment',
      id: 'deleted-comment',
      exists: false,
      title: null,
      content_excerpt: null,
      author_username: null,
    });
  });

  it('returns 404 for an unknown report', async () => {
    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates a valid status and audits it in the same transaction', async () => {
    detailRow = {
      id: 'report-1',
      reporter_username: 'reporter',
      reported_username: 'target',
      reported_user_id: 'target-id',
      reason: 'spam',
      status: 'open',
      resolution: null,
      context_type: null,
      context_id: null,
      description: 'detail',
      resolution_note: null,
      reviewed_by_username: null,
      created_at: '2026-10-25T10:00:00Z',
      reviewed_at: null,
    };
    const input = {
      status: 'resolved',
      resolution: 'user_suspended',
      resolution_note: 'reviewed',
    } as UpdateReportStatusDto;

    const result = await service.updateStatus('report-1', input, 'admin-id');

    expect(result.status).toBe('resolved');
    expect(result.resolution).toBe('user_suspended');
    expect(result.resolution_note).toBe('reviewed');
    expect(transaction).toEqual({ commits: 1, rollbacks: 0, releases: 1 });
    expect(auditEntries).toHaveLength(1);
    const { connection: auditConnection, entry } = auditEntries[0];
    expect(auditConnection).toBeDefined();
    expect(entry).toEqual({
      actorId: 'admin-id',
      action: 'report_status_changed',
      targetType: 'report',
      targetId: 'report-1',
      metadata: {
        from_status: 'open',
        to_status: 'resolved',
        resolution: 'user_suspended',
      },
    });
    expect(JSON.stringify(entry)).not.toContain('resolution_note');
    const mutations = calls.filter((call) =>
      /^(UPDATE|INSERT|DELETE)/.test(call.sql),
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0].sql).toContain('UPDATE user_reports');
    expect(mutations[0].sql).toContain('reviewed_at = UTC_TIMESTAMP()');
  });

  it.each(['under_review', 'rejected'] as const)(
    'allows open reports to move to %s without a resolution outcome',
    async (status) => {
      detailRow = {
        id: 'report-1',
        reporter_username: 'reporter',
        reported_username: 'target',
        reported_user_id: 'target-id',
        reason: 'spam',
        status: 'open',
        resolution: null,
        context_type: null,
        context_id: null,
        description: 'detail',
        resolution_note: null,
        reviewed_by_username: null,
        created_at: '2026-10-25T10:00:00Z',
        reviewed_at: null,
      };

      await service.updateStatus('report-1', { status }, 'admin-id');

      const update = calls.find((call) =>
        call.sql.startsWith('UPDATE user_reports'),
      );
      expect(update?.values[0]).toBe(status);
      expect(update?.values[1]).toBeNull();
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].entry).toMatchObject({
        metadata: {
          from_status: 'open',
          to_status: status,
          resolution: null,
        },
      });
    },
  );

  it('rejects terminal transitions and self-review without writing', async () => {
    transitionRow = {
      id: 'report-1',
      reporter_id: 'reporter-id',
      reported_user_id: 'target-id',
      status: 'resolved',
    };
    await expect(
      service.updateStatus('report-1', { status: 'rejected' }, 'admin-id'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.rollbacks).toBe(1);

    transitionRow = {
      id: 'report-1',
      reporter_id: 'admin-id',
      reported_user_id: 'target-id',
      status: 'open',
    };
    await expect(
      service.updateStatus('report-1', { status: 'under_review' }, 'admin-id'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction.rollbacks).toBe(2);
    expect(
      calls.some((call) => call.sql.startsWith('UPDATE user_reports')),
    ).toBe(false);
  });

  it('rolls back the report status when audit recording fails', async () => {
    failAudit = true;
    await expect(
      service.updateStatus(
        'report-1',
        {
          status: 'resolved',
          resolution: 'no_action',
        },
        'admin-id',
      ),
    ).rejects.toThrow('Audit insert failed');
    expect(transaction).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
  });

  it('returns conflict when a conditional status update loses a race', async () => {
    updateAffectedRows = 0;

    await expect(
      service.updateStatus('report-1', { status: 'under_review' }, 'admin-id'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(transaction).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    expect(auditEntries).toHaveLength(0);
  });

  describe('withdrawn reports', () => {
    const whereOf = (sql: string) =>
      sql.slice(
        sql.indexOf(' WHERE '),
        sql.includes(' ORDER BY') ? sql.indexOf(' ORDER BY') : sql.length,
      );

    it('leaves withdrawn reports out of the queue by default, in page and count', async () => {
      const result = await service.findAll({} as ListReportsDto);
      const [list, countQuery] = calls;
      for (const { sql } of [list, countQuery]) {
        expect(whereOf(sql)).toContain('ur.withdrawn_at IS NULL');
      }
      expect(result.filters.withdrawn).toBe('exclude');
    });

    it('keeps the default exclusion alongside other filters, without a parameter', async () => {
      await service.findAll({
        status: 'open',
        withdrawn: 'exclude',
      } as ListReportsDto);
      expect(whereOf(calls[0].sql)).toContain(
        'ur.status = ? AND ur.withdrawn_at IS NULL',
      );
      expect(calls[1].values).toEqual(['open']);
    });

    it('includes withdrawn reports under withdrawn=include', async () => {
      const result = await service.findAll({
        withdrawn: 'include',
      } as ListReportsDto);
      for (const { sql } of calls) {
        expect(sql).not.toContain('withdrawn_at IS NULL');
        expect(sql).not.toContain('withdrawn_at IS NOT NULL');
      }
      expect(result.filters.withdrawn).toBe('include');
    });

    it('lists only withdrawn reports under withdrawn=only', async () => {
      const result = await service.findAll({
        withdrawn: 'only',
      } as ListReportsDto);
      for (const { sql } of calls.slice(0, 2)) {
        expect(whereOf(sql)).toContain('ur.withdrawn_at IS NOT NULL');
      }
      expect(result.filters.withdrawn).toBe('only');
    });

    it('marks a withdrawn report in the list and the detail', async () => {
      listRows = [
        {
          id: 'r1',
          reporter_username: 'reporter',
          reported_username: 'target',
          target_type: 'user',
          target_id: 'target-id',
          target_label: 'target',
          reason: 'spam',
          status: 'open',
          resolution: null,
          context_type: null,
          context_id: null,
          created_at: '2026-10-25T10:00:00Z',
          reviewed_at: null,
          withdrawn_at: '2026-10-26T09:00:00Z',
        },
      ];
      detailRow = {
        ...listRows[0],
        reported_user_id: 'target-id',
        description: 'detail',
        resolution_note: null,
        reviewed_by_username: null,
      };
      const list = await service.findAll({
        withdrawn: 'include',
      } as ListReportsDto);
      expect(list.items[0].withdrawn_at).toBe('2026-10-26T09:00:00.000Z');

      const detail = await service.findOne('r1');
      expect(detail.withdrawn_at).toBe('2026-10-26T09:00:00.000Z');
      expect(calls.at(-3)?.sql).not.toContain('withdrawn_at IS NULL');
    });

    it('reads withdrawn_at as null for a report that stands', async () => {
      listRows = [
        {
          id: 'r1',
          reporter_username: null,
          reported_username: null,
          reason: 'spam',
          status: 'open',
          resolution: null,
          context_type: null,
          context_id: null,
          created_at: '2026-10-25T10:00:00Z',
          reviewed_at: null,
        },
      ];
      const list = await service.findAll({} as ListReportsDto);
      expect(list.items[0].withdrawn_at).toBeNull();
    });

    it.each(['under_review', 'resolved', 'rejected'] as const)(
      'refuses to move a withdrawn report to %s with 409, writing nothing',
      async (status) => {
        transitionRow = {
          ...transitionRow!,
          withdrawn_at: '2026-10-26T09:00:00Z',
        };
        const body =
          status === 'resolved'
            ? { status, resolution: 'no_action' as const }
            : { status };

        await expect(
          service.updateStatus('report-1', body, 'admin-id'),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(calls[0].sql).toContain('withdrawn_at');
        expect(calls[0].sql).toContain('FOR UPDATE');
        expect(
          calls.some((call) => call.sql.startsWith('UPDATE user_reports')),
        ).toBe(false);
        expect(auditEntries).toHaveLength(0);
        expect(notificationEntries).toHaveLength(0);
        expect(transaction).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
      },
    );

    it('guards the transition update itself against a withdrawal', async () => {
      detailRow = {
        id: 'report-1',
        reporter_username: 'reporter',
        reported_username: 'target',
        reported_user_id: 'target-id',
        reason: 'spam',
        status: 'open',
        resolution: null,
        context_type: null,
        context_id: null,
        description: null,
        resolution_note: null,
        reviewed_by_username: null,
        created_at: '2026-10-25T10:00:00Z',
        reviewed_at: null,
      };
      await service.updateStatus(
        'report-1',
        { status: 'under_review' },
        'admin-id',
      );
      const mutation = calls.find((call) =>
        call.sql.startsWith('UPDATE user_reports'),
      );
      expect(mutation?.sql).toContain('AND withdrawn_at IS NULL');
    });

    it('answers a withdrawal that lands between the lock and the update with 409', async () => {
      updateAffectedRows = 0;
      await expect(
        service.updateStatus('report-1', { status: 'rejected' }, 'admin-id'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(transaction.releases).toBe(1);
    });
  });

  describe('reporter notifications', () => {
    beforeEach(() => {
      detailRow = {
        id: 'report-1',
        reporter_username: 'reporter',
        reported_username: 'target',
        reported_user_id: 'target-id',
        reason: 'spam',
        status: 'open',
        resolution: null,
        context_type: null,
        context_id: null,
        description: 'detail',
        resolution_note: null,
        reviewed_by_username: null,
        created_at: '2026-10-25T10:00:00Z',
        reviewed_at: null,
      };
    });

    it.each(['resolved', 'rejected'] as const)(
      'tells the reporter only that the report was %s, on the transaction connection',
      async (status) => {
        await service.updateStatus(
          'report-1',
          {
            status,
            resolution: status === 'resolved' ? 'user_banned' : undefined,
            resolution_note: 'internal: repeat offender',
          },
          'admin-id',
        );

        expect(notificationEntries).toHaveLength(1);
        expect(notificationEntries[0].connection).toBe(usedConnection);
        expect(notificationEntries[0].entry).toEqual({
          recipientId: 'reporter-id',
          type: 'report_resolved',
          actorId: null,
          subjectType: 'report',
          subjectId: 'report-1',
          communityId: null,
          metadata: { status },
        });
        const serialised = JSON.stringify(notificationEntries[0].entry);
        for (const leaked of [
          'resolution',
          'user_banned',
          'internal',
          'admin-id',
          'target-id',
        ]) {
          expect(serialised).not.toContain(leaked);
        }
        expect(transaction).toEqual({ commits: 1, rollbacks: 0, releases: 1 });
        expect(auditEntries).toHaveLength(1);
      },
    );

    it('writes nothing for under_review', async () => {
      await service.updateStatus(
        'report-1',
        { status: 'under_review' },
        'admin-id',
      );

      expect(notificationEntries).toEqual([]);
      expect(auditEntries).toHaveLength(1);
    });

    it('writes nothing, and does not throw, when the reporter was deleted', async () => {
      transitionRow = { ...transitionRow!, reporter_id: null };

      await expect(
        service.updateStatus('report-1', { status: 'rejected' }, 'admin-id'),
      ).resolves.toMatchObject({ status: 'rejected' });

      expect(notificationEntries).toEqual([]);
      expect(transaction).toEqual({ commits: 1, rollbacks: 0, releases: 1 });
    });

    it('writes nothing for an update that would not change the status', async () => {
      transitionRow = { ...transitionRow!, status: 'resolved' };

      await expect(
        service.updateStatus('report-1', { status: 'resolved' }, 'admin-id'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.updateStatus(
          'report-1',
          { status: 'under_review' },
          'admin-id',
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(notificationEntries).toEqual([]);
      expect(auditEntries).toEqual([]);
    });

    it('rolls the status change back when the notification write fails', async () => {
      failNotification = true;

      await expect(
        service.updateStatus('report-1', { status: 'rejected' }, 'admin-id'),
      ).rejects.toThrow('Notification insert failed');

      expect(transaction).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });
  });
});
