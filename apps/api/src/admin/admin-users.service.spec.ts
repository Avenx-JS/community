import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { AdminUsersService } from './admin-users.service';
import { ListUsersDto } from './dto/list-users.dto';

describe('AdminUsersService', () => {
  let service: AdminUsersService;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let users: Array<Record<string, unknown>>;
  let total: number;
  let activity: Record<string, number | string>;
  let reports: Record<string, number | string>;

  beforeEach(async () => {
    calls = [];
    users = [];
    total = 0;
    activity = {
      posts_count: 0,
      comments_count: 0,
      votes_count: 0,
      communities_created: 0,
      subscriptions_count: 0,
      moderated_communities_count: 0,
    };
    reports = {
      open: 0,
      under_review: 0,
      resolved: 0,
      rejected: 0,
      reports_filed_count: 0,
    };
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes('AS posts_count')) {
          return Promise.resolve([[activity], []]);
        }
        if (sql.includes('AS reports_filed_count')) {
          return Promise.resolve([[reports], []]);
        }
        if (sql.startsWith('SELECT COUNT(*) AS total')) {
          return Promise.resolve([[{ total }], []]);
        }
        if (sql.includes('WHERE u.id = ? LIMIT 1')) {
          return Promise.resolve([users.slice(0, 1), []]);
        }
        if (sql.includes('report_counts.open_reports_against')) {
          return Promise.resolve([users, []]);
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [AdminUsersService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();
    service = module.get<AdminUsersService>(AdminUsersService);
  });

  it('applies escaped search, role, and half-open date filters to list and count', async () => {
    await service.findAll({
      search: 'a%_=b',
      role: 'admin',
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
      page: 2,
      limit: 10,
      sort: 'username',
    });

    const [list, countQuery] = calls;
    const listWhere = list.sql
      .slice(list.sql.indexOf(' WHERE '), list.sql.indexOf(' ORDER BY'))
      .trim();
    expect(countQuery.sql).toContain(listWhere);
    expect(list.values).toEqual([
      '%a=%=_==b%',
      'admin',
      '2026-01-01 00:00:00',
      '2026-02-01 00:00:00',
      10,
      10,
    ]);
    expect(countQuery.values).toEqual(list.values.slice(0, 4));
    expect(list.sql).toContain("LIKE LOWER(?) ESCAPE '='");
    expect(list.sql).toContain('ORDER BY u.username ASC, u.id ASC');
  });

  it.each([
    ['new', 'u.created_at DESC, u.id DESC'],
    ['oldest', 'u.created_at ASC, u.id ASC'],
    ['username', 'u.username ASC, u.id ASC'],
  ] as const)('uses stable %s ordering', async (sort, order) => {
    await service.findAll({ sort } as ListUsersDto);
    expect(calls[0].sql).toContain(`ORDER BY ${order}`);
  });

  it('returns a safe list envelope and uses two statements for 100 accounts', async () => {
    users = Array.from({ length: 100 }, (_, index) => ({
      id: `user-${index}`,
      username: `member_${index}`,
      role: 'user',
      created_at: '2026-01-01T00:00:00Z',
      open_reports_against: '2',
    }));
    total = 100;

    const result = await service.findAll({ limit: 100 } as ListUsersDto);

    expect(result.items).toHaveLength(100);
    expect(result.items[0]).toEqual({
      id: 'user-0',
      username: 'member_0',
      role: 'user',
      created_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
      restriction_expires_at: null,
      open_reports_against: 2,
    });
    expect(result.total).toBe(100);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/email|password_hash|token/i);
  });

  it('returns activity and report counts with zeros for empty aggregates', async () => {
    users = [
      {
        id: 'user-1',
        username: 'member',
        role: 'user',
        created_at: new Date('2026-01-01T00:00:00Z'),
        open_reports_against: 0,
      },
    ];
    activity = {
      posts_count: '3',
      comments_count: '4',
      votes_count: '5',
      communities_created: '1',
      subscriptions_count: '2',
      moderated_communities_count: '1',
    };
    reports = {
      open: '1',
      under_review: '2',
      resolved: '3',
      rejected: '4',
      reports_filed_count: '5',
    };

    const detail = await service.findOne('user-1');

    expect(detail).toMatchObject({
      posts_count: 3,
      comments_count: 4,
      votes_count: 5,
      communities_created: 1,
      subscriptions_count: 2,
      moderated_communities_count: 1,
      reports_against: {
        open: 1,
        under_review: 2,
        resolved: 3,
        rejected: 4,
      },
      reports_filed_count: 5,
      last_seen_at: null,
    });
    expect(calls).toHaveLength(3);
    expect(calls[1].sql).toContain(
      '(SELECT COUNT(*) FROM posts WHERE author_id = ?)',
    );
    expect(calls[1].values).toEqual(Array.from({ length: 6 }, () => 'user-1'));
    expect(JSON.stringify(detail)).not.toMatch(/email|password_hash|token/i);
  });

  it('returns not found for an unknown account without issuing aggregate queries', async () => {
    await expect(service.findOne('unknown')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(calls).toHaveLength(1);
  });
});
