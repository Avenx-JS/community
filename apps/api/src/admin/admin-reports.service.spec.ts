import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { ListReportsDto } from './dto/list-reports.dto';
import { AdminReportsService } from './admin-reports.service';

describe('AdminReportsService', () => {
  let service: AdminReportsService;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let listRows: Array<Record<string, unknown>>;
  let count = 0;
  let detailRow: Record<string, unknown> | undefined;
  let contextRow: Record<string, unknown> | undefined;
  let resolutionRows: Array<Record<string, unknown>>;

  beforeEach(async () => {
    calls = [];
    listRows = [];
    count = 0;
    detailRow = undefined;
    contextRow = undefined;
    resolutionRows = [];
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [AdminReportsService, { provide: MYSQL_POOL, useValue: pool }],
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
});
