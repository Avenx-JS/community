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
  let resolutionRows: Array<Record<string, unknown>>;
  let transitionRow:
    | {
        id: string;
        reporter_id: string | null;
        reported_user_id: string;
        status: 'open' | 'under_review' | 'resolved' | 'rejected';
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
          return Promise.resolve([listRows, []]);
        }
        if (sql.startsWith('SELECT COUNT(*) AS total')) {
          return Promise.resolve([[{ total: count }], []]);
        }
        if (
          sql.startsWith('SELECT ur.id, reporter_user.username') &&
          sql.includes('ur.description')
        ) {
          return Promise.resolve([detailRow ? [detailRow] : [], []]);
        }
        if (
          sql.startsWith('SELECT ') &&
          sql.includes('context.content AS content')
        ) {
          return Promise.resolve([contextRow ? [contextRow] : [], []]);
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
            transitionRow ? [{ ...transitionRow }] : [],
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
        },
      ],
      page: 1,
      limit: 20,
      total: 1,
      filters: {
        status: null,
        reason: null,
        reported_username: null,
        reporter_username: null,
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
