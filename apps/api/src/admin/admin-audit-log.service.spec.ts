import { beforeEach, describe, expect, it } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  AdminActionRow,
  AdminAuditLogService,
  toAdminActionItem,
} from './admin-audit-log.service';
import { ListAdminActionsDto } from './dto/list-admin-actions.dto';

const query = (overrides: Partial<ListAdminActionsDto> = {}) =>
  Object.assign(new ListAdminActionsDto(), overrides);

describe('AdminAuditLogService', () => {
  let service: AdminAuditLogService;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let rows: Array<Record<string, unknown>>;
  let count: number;

  beforeEach(async () => {
    calls = [];
    rows = [];
    count = 0;
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT id, actor_id')) {
          return Promise.resolve([rows, []]);
        }
        if (sql.startsWith('SELECT COUNT(*) AS total')) {
          return Promise.resolve([[{ total: count }], []]);
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminAuditLogService,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();

    service = module.get(AdminAuditLogService);
  });

  const whereOf = (sql: string) => {
    const start = sql.indexOf(' WHERE ');
    if (start === -1) return '';
    const end = sql.indexOf(' ORDER BY');
    return sql.slice(start, end === -1 ? sql.length : end).trim();
  };

  it('lists newest first without filters and echoes defaults', async () => {
    count = 3;

    const result = await service.findAll(query());

    const [list, total] = calls;
    expect(list.sql).not.toContain('WHERE');
    expect(list.sql).toContain(
      'ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    );
    expect(list.values).toEqual([20, 0]);
    expect(total.sql).toBe('SELECT COUNT(*) AS total FROM admin_actions');
    expect(total.values).toEqual([]);
    expect(result).toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 3,
      filters: {
        actor_username: null,
        action: null,
        target_type: null,
        target_id: null,
        from: null,
        to: null,
        sort: 'new',
      },
    });
  });

  it('maps the oldest sort to ascending order with the id tiebreaker', async () => {
    await service.findAll(query({ sort: 'oldest', page: 3, limit: 10 }));

    expect(calls[0].sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(calls[0].values).toEqual([10, 20]);
  });

  it.each([
    [{ actor_username: 'admin' }, 'actor_username = ?', ['admin']],
    [{ action: 'user_banned' }, 'action = ?', ['user_banned']],
    [{ target_type: 'report' }, 'target_type = ?', ['report']],
    [
      { from: '2026-01-01T00:00:00Z' },
      "created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
      ['2026-01-01 00:00:00'],
    ],
    [
      { to: '2026-01-02T01:00:00+01:00' },
      "created_at < CONVERT_TZ(?, '+00:00', @@session.time_zone)",
      ['2026-01-02 00:00:00'],
    ],
  ] as const)(
    'builds the WHERE clause for %o',
    async (filter, clause, bound) => {
      await service.findAll(query(filter));

      const [list, total] = calls;
      expect(whereOf(list.sql)).toBe(`WHERE ${clause}`);
      expect(list.values).toEqual([...bound, 20, 0]);
      expect(whereOf(total.sql)).toBe(whereOf(list.sql));
      expect(total.values).toEqual(bound);
    },
  );

  it('combines every filter in a fixed order and reuses it for the count', async () => {
    const result = await service.findAll(
      query({
        actor_username: 'admin',
        action: 'restriction_lifted',
        target_type: 'restriction',
        target_id: 'restriction-1',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
      }),
    );

    const [list, total] = calls;
    expect(whereOf(list.sql)).toBe(
      'WHERE actor_username = ? AND action = ? AND target_type = ? AND target_id = ?' +
        " AND created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)" +
        " AND created_at < CONVERT_TZ(?, '+00:00', @@session.time_zone)",
    );
    const bound = [
      'admin',
      'restriction_lifted',
      'restriction',
      'restriction-1',
      '2026-01-01 00:00:00',
      '2026-02-01 00:00:00',
    ];
    expect(list.values).toEqual([...bound, 20, 0]);
    expect(total.sql).toBe(
      `SELECT COUNT(*) AS total FROM admin_actions ${whereOf(list.sql)}`,
    );
    expect(total.values).toEqual(bound);
    expect(result.filters).toMatchObject({
      target_type: 'restriction',
      target_id: 'restriction-1',
      from: '2026-01-01T00:00:00Z',
    });
  });

  it('returns mapped items', async () => {
    rows = [
      {
        id: 'action-1',
        actor_id: null,
        actor_username: 'departed_admin',
        action: 'user_banned',
        target_type: 'user',
        target_id: 'deleted-user',
        metadata: { restriction_id: 'r-1', report_id: null },
        created_at: new Date('2026-03-01T00:00:00Z'),
      },
    ];
    count = 1;

    const result = await service.findAll(query());

    expect(result.items).toEqual([
      {
        id: 'action-1',
        actor_username: 'departed_admin',
        actor_id: null,
        action: 'user_banned',
        target_type: 'user',
        target_id: 'deleted-user',
        metadata: { restriction_id: 'r-1', report_id: null },
        created_at: '2026-03-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('toAdminActionItem', () => {
  const row = (overrides: Record<string, unknown>) =>
    ({
      id: 'action-1',
      actor_id: 'admin-id',
      actor_username: 'admin',
      action: 'report_status_changed',
      target_type: 'report',
      target_id: 'report-1',
      metadata: null,
      created_at: '2026-03-01T00:00:00Z',
      ...overrides,
    }) as AdminActionRow;

  it('keeps null metadata and a present actor id', () => {
    expect(toAdminActionItem(row({}))).toMatchObject({
      actor_id: 'admin-id',
      metadata: null,
      created_at: '2026-03-01T00:00:00.000Z',
    });
  });

  it('returns object metadata as stored and parses string metadata', () => {
    const metadata = { from_status: 'open', to_status: 'resolved' };
    expect(toAdminActionItem(row({ metadata })).metadata).toEqual(metadata);
    expect(
      toAdminActionItem(row({ metadata: JSON.stringify(metadata) })).metadata,
    ).toEqual(metadata);
  });

  it('keeps the username snapshot when the actor was deleted', () => {
    expect(toAdminActionItem(row({ actor_id: null }))).toMatchObject({
      actor_id: null,
      actor_username: 'admin',
    });
  });
});
