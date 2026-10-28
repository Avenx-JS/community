import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthService, MYSQL_POOL } from '../auth/auth.service';
import type { PlatformRole } from '../users/users.service';
import { AuditLogService } from './audit-log.service';
import {
  AdminRestrictionsService,
  toAdminRestrictionDto,
  RestrictionRecord,
} from './admin-restrictions.service';

interface RestrictionFixture {
  id: string;
  user_id: string;
  type: 'suspension' | 'ban';
  reason: string;
  created_by: string | null;
  created_at: Date;
  expires_at: Date | null;
  lifted_at: Date | null;
  lifted_by: string | null;
  lift_reason: string | null;
  report_id: string | null;
}

const isActive = (row: RestrictionFixture) =>
  row.lifted_at === null &&
  (row.expires_at === null || row.expires_at.getTime() > Date.now());

describe('AdminRestrictionsService', () => {
  let service: AdminRestrictionsService;
  let users: Map<string, { username: string; role: PlatformRole }>;
  let reports: Set<string>;
  let restrictions: RestrictionFixture[];
  let calls: Array<{ sql: string; values: unknown[] }>;
  let events: string[];
  let auditRows: unknown[][];
  let failAudit: boolean;
  let logoutAll: jest.Mock<(userId: string) => Promise<void>>;
  let userLocks: Map<string, Promise<void>>;
  let transaction: { commits: number; rollbacks: number; releases: number };

  const restrictionRow = (row: RestrictionFixture) => ({
    id: row.id,
    type: row.type,
    reason: row.reason,
    created_by_username: row.created_by
      ? (users.get(row.created_by)?.username ?? null)
      : null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    lifted_at: row.lifted_at,
    lifted_by_username: row.lifted_by
      ? (users.get(row.lifted_by)?.username ?? null)
      : null,
    lift_reason: row.lift_reason,
    report_id: row.report_id,
    active: isActive(row) ? 1 : 0,
  });

  const fixture = (
    overrides: Partial<RestrictionFixture> = {},
  ): RestrictionFixture => ({
    id: 'restriction-1',
    user_id: 'target-id',
    type: 'suspension',
    reason: 'Spam',
    created_by: 'admin-id',
    created_at: new Date('2026-10-01T00:00:00Z'),
    expires_at: new Date(Date.now() + 3_600_000),
    lifted_at: null,
    lifted_by: null,
    lift_reason: null,
    report_id: null,
    ...overrides,
  });

  const createConnection = () => {
    let undo: Array<() => void> = [];
    let unlock: (() => void) | undefined;
    const finish = () => {
      unlock?.();
      unlock = undefined;
    };
    return {
      beginTransaction: () => {
        undo = [];
        return Promise.resolve();
      },
      commit: () => {
        transaction.commits += 1;
        events.push('commit');
        finish();
        return Promise.resolve();
      },
      rollback: () => {
        transaction.rollbacks += 1;
        events.push('rollback');
        undo.reverse().forEach((step) => step());
        finish();
        return Promise.resolve();
      },
      release: () => {
        transaction.releases += 1;
        finish();
      },
      execute: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        if (
          sql === 'SELECT id, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE'
        ) {
          const userId = String(values[0]);
          const previous = userLocks.get(userId) ?? Promise.resolve();
          const current = new Promise<void>((resolve) => {
            unlock = resolve;
          });
          userLocks.set(
            userId,
            previous.then(() => current),
          );
          await previous;
          const user = users.get(userId);
          return [user ? [{ id: userId, role: user.role }] : [], []];
        }
        if (sql === 'SELECT id FROM user_reports WHERE id = ? LIMIT 1') {
          return [
            reports.has(String(values[0])) ? [{ id: values[0] }] : [],
            [],
          ];
        }
        if (sql.startsWith('SELECT id FROM user_restrictions')) {
          return [
            restrictions
              .filter((row) => row.user_id === values[0] && isActive(row))
              .map((row) => ({ id: row.id })),
            [],
          ];
        }
        if (sql.startsWith('INSERT INTO user_restrictions')) {
          const withDuration = sql.includes(
            'DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR)',
          );
          const [id, userId, type, reason, createdBy] = values as string[];
          undo.push(() => {
            restrictions = restrictions.filter((row) => row.id !== id);
          });
          restrictions.push(
            fixture({
              id,
              user_id: userId,
              type: type as 'suspension' | 'ban',
              reason,
              created_by: createdBy,
              created_at: new Date(),
              expires_at: withDuration
                ? new Date(Date.now() + Number(values[5]) * 3_600_000)
                : null,
              report_id:
                (values[withDuration ? 6 : 5] as string | null) ?? null,
            }),
          );
          return [{ affectedRows: 1 }, []];
        }
        if (sql.startsWith('UPDATE user_restrictions')) {
          const [liftedBy, liftReason, id, userId] = values as string[];
          const row = restrictions.find(
            (candidate) =>
              candidate.id === id &&
              candidate.user_id === userId &&
              candidate.lifted_at === null,
          );
          if (row) {
            undo.push(() => {
              row.lifted_at = null;
              row.lifted_by = null;
              row.lift_reason = null;
            });
            row.lifted_at = new Date();
            row.lifted_by = liftedBy;
            row.lift_reason = liftReason;
          }
          return [{ affectedRows: row ? 1 : 0 }, []];
        }
        if (sql.startsWith('SELECT id, user_id, lifted_at')) {
          const row = restrictions.find(
            (candidate) => candidate.id === values[0],
          );
          return [row ? [row] : [], []];
        }
        if (sql.startsWith('SELECT r.id')) {
          const row = restrictions.find(
            (candidate) =>
              candidate.id === values[0] && candidate.user_id === values[1],
          );
          return [row ? [restrictionRow(row)] : [], []];
        }
        if (sql === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
          const user = users.get(String(values[0]));
          return [user ? [{ username: user.username }] : [], []];
        }
        if (sql.startsWith('INSERT INTO admin_actions')) {
          if (failAudit) {
            throw new Error('Audit insert failed');
          }
          auditRows.push(values);
          events.push('audit');
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      },
    };
  };

  beforeEach(async () => {
    users = new Map([
      ['admin-id', { username: 'admin', role: 'admin' }],
      ['other-admin-id', { username: 'other_admin', role: 'admin' }],
      ['target-id', { username: 'target', role: 'user' }],
      ['moderator-id', { username: 'mod', role: 'moderator' }],
    ]);
    reports = new Set(['report-1']);
    restrictions = [];
    calls = [];
    events = [];
    auditRows = [];
    failAudit = false;
    userLocks = new Map();
    transaction = { commits: 0, rollbacks: 0, releases: 0 };
    logoutAll = jest.fn((userId: string) => {
      events.push(`logoutAll:${userId}`);
      return Promise.resolve();
    });

    const pool = {
      getConnection: () => Promise.resolve(createConnection()),
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        if (sql === 'SELECT id FROM users WHERE id = ? LIMIT 1') {
          return Promise.resolve([
            users.has(String(values[0])) ? [{ id: values[0] }] : [],
            [],
          ]);
        }
        if (sql.startsWith('SELECT r.id')) {
          const [userId, limit, offset] = values as [string, number, number];
          const rows = restrictions
            .filter((row) => row.user_id === userId)
            .sort(
              (left, right) =>
                right.created_at.getTime() - left.created_at.getTime() ||
                right.id.localeCompare(left.id),
            )
            .slice(offset, offset + limit)
            .map(restrictionRow);
          return Promise.resolve([rows, []]);
        }
        if (sql.startsWith('SELECT COUNT(*) AS total FROM user_restrictions')) {
          return Promise.resolve([
            [
              {
                total: restrictions.filter((row) => row.user_id === values[0])
                  .length,
              },
            ],
            [],
          ]);
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminRestrictionsService,
        AuditLogService,
        { provide: MYSQL_POOL, useValue: pool },
        { provide: AuthService, useValue: { logoutAll } },
      ],
    }).compile();

    service = module.get(AdminRestrictionsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('apply', () => {
    it('creates a suspension with a database-derived deadline', async () => {
      const result = await service.apply(
        'target-id',
        { type: 'suspension', reason: 'Spam', duration_hours: 72 },
        'admin-id',
      );

      const insert = calls.find((call) =>
        call.sql.startsWith('INSERT INTO user_restrictions'),
      );
      expect(insert?.sql).toContain(
        'DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR)',
      );
      expect(insert?.values).toEqual([
        result.id,
        'target-id',
        'suspension',
        'Spam',
        'admin-id',
        72,
        null,
      ]);
      expect(insert?.values.some((value) => value instanceof Date)).toBe(false);
      expect(result).toMatchObject({
        type: 'suspension',
        reason: 'Spam',
        created_by_username: 'admin',
        lifted_at: null,
        active: true,
      });
      expect(result.expires_at).not.toBeNull();
      expect(restrictions).toHaveLength(1);
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0][3]).toBe('user_suspended');
      expect(auditRows[0][4]).toBe('user');
      expect(auditRows[0][5]).toBe('target-id');
      expect(JSON.parse(String(auditRows[0][6]))).toEqual({
        restriction_id: result.id,
        expires_at: result.expires_at,
        report_id: null,
      });
    });

    it('creates a ban with no expiry and links an existing report', async () => {
      const result = await service.apply(
        'target-id',
        { type: 'ban', reason: 'Repeated abuse', report_id: 'report-1' },
        'admin-id',
      );

      const insert = calls.find((call) =>
        call.sql.startsWith('INSERT INTO user_restrictions'),
      );
      expect(insert?.sql).not.toContain('INTERVAL');
      expect(insert?.values).toEqual([
        result.id,
        'target-id',
        'ban',
        'Repeated abuse',
        'admin-id',
        'report-1',
      ]);
      expect(result).toMatchObject({
        type: 'ban',
        expires_at: null,
        report_id: 'report-1',
        active: true,
      });
      expect(auditRows[0][3]).toBe('user_banned');
      expect(JSON.parse(String(auditRows[0][6]))).toEqual({
        restriction_id: result.id,
        report_id: 'report-1',
      });
    });

    it('locks the user row and re-checks active restrictions before inserting', async () => {
      await service.apply(
        'target-id',
        { type: 'ban', reason: 'Abuse' },
        'admin-id',
      );

      const order = calls.map((call) => call.sql);
      const lock = order.findIndex((sql) =>
        sql.includes('FROM users WHERE id = ? LIMIT 1 FOR UPDATE'),
      );
      const recheck = order.findIndex((sql) =>
        sql.startsWith('SELECT id FROM user_restrictions'),
      );
      const insert = order.findIndex((sql) =>
        sql.startsWith('INSERT INTO user_restrictions'),
      );
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(recheck).toBeGreaterThan(lock);
      expect(insert).toBeGreaterThan(recheck);
      expect(order[recheck]).toContain('lifted_at IS NULL');
      expect(order[recheck]).toContain('FOR UPDATE');
    });

    it('returns 409 and inserts nothing when an active restriction exists', async () => {
      restrictions.push(fixture());

      await expect(
        service.apply(
          'target-id',
          { type: 'ban', reason: 'Escalate' },
          'admin-id',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(restrictions).toHaveLength(1);
      expect(auditRows).toHaveLength(0);
      expect(transaction).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
      expect(logoutAll).not.toHaveBeenCalled();
    });

    it('allows a new restriction once the previous one expired or was lifted', async () => {
      restrictions.push(
        fixture({ id: 'expired', expires_at: new Date(Date.now() - 1000) }),
        fixture({ id: 'lifted', lifted_at: new Date(), lifted_by: 'admin-id' }),
      );

      await expect(
        service.apply(
          'target-id',
          { type: 'ban', reason: 'Abuse' },
          'admin-id',
        ),
      ).resolves.toMatchObject({ type: 'ban', active: true });
    });

    it('refuses self-restriction without touching the database', async () => {
      await expect(
        service.apply('admin-id', { type: 'ban', reason: 'Oops' }, 'admin-id'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(calls).toHaveLength(0);
    });

    it('refuses to restrict administrators but allows moderators', async () => {
      await expect(
        service.apply(
          'other-admin-id',
          { type: 'ban', reason: 'Abuse' },
          'admin-id',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(restrictions).toHaveLength(0);

      await expect(
        service.apply(
          'moderator-id',
          { type: 'ban', reason: 'Abuse' },
          'admin-id',
        ),
      ).resolves.toMatchObject({ type: 'ban' });
    });

    it('returns 404 for an unknown user or report and inserts nothing', async () => {
      await expect(
        service.apply('missing-id', { type: 'ban', reason: 'X' }, 'admin-id'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.apply(
          'target-id',
          { type: 'ban', reason: 'X', report_id: 'missing-report' },
          'admin-id',
        ),
      ).rejects.toThrow('Report not found');
      expect(restrictions).toHaveLength(0);
      expect(transaction).toEqual({ commits: 0, rollbacks: 2, releases: 2 });
    });

    it('rolls back the restriction when the audit write fails', async () => {
      failAudit = true;

      await expect(
        service.apply('target-id', { type: 'ban', reason: 'X' }, 'admin-id'),
      ).rejects.toThrow('Audit insert failed');
      expect(restrictions).toHaveLength(0);
      expect(transaction).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
      expect(logoutAll).not.toHaveBeenCalled();
    });

    it('releases the connection even when rollback is not reached', async () => {
      users.delete('admin-id');
      users.set('admin-id', { username: '', role: 'admin' });

      await expect(
        service.apply('target-id', { type: 'ban', reason: 'X' }, 'admin-id'),
      ).rejects.toThrow('Audit actor could not be resolved');
      expect(transaction.releases).toBe(1);
    });

    it('revokes sessions only after the commit', async () => {
      await service.apply(
        'target-id',
        { type: 'ban', reason: 'X' },
        'admin-id',
      );

      expect(events).toEqual(['audit', 'commit', 'logoutAll:target-id']);
      expect(logoutAll).toHaveBeenCalledTimes(1);
    });

    it('keeps the restriction when session revocation fails', async () => {
      logoutAll.mockRejectedValueOnce(new Error('pool exhausted'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const result = await service.apply(
        'target-id',
        { type: 'ban', reason: 'X' },
        'admin-id',
      );

      expect(result.active).toBe(true);
      expect(restrictions).toHaveLength(1);
      expect(transaction.commits).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain('pool exhausted');
    });

    it('lets exactly one of two concurrent applies succeed', async () => {
      const results = await Promise.allSettled([
        service.apply('target-id', { type: 'ban', reason: 'A' }, 'admin-id'),
        service.apply(
          'target-id',
          { type: 'suspension', reason: 'B', duration_hours: 24 },
          'admin-id',
        ),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(restrictions).toHaveLength(1);
      expect(auditRows).toHaveLength(1);
    });
  });

  describe('lift', () => {
    beforeEach(() => {
      restrictions.push(fixture());
    });

    it('lifts with a conditional update and audits inside the transaction', async () => {
      const result = await service.lift(
        'target-id',
        'restriction-1',
        { lift_reason: 'Appeal accepted' },
        'admin-id',
      );

      const update = calls.find((call) =>
        call.sql.startsWith('UPDATE user_restrictions'),
      );
      expect(update?.sql).toContain('lifted_at = UTC_TIMESTAMP()');
      expect(update?.sql).toContain(
        'WHERE id = ? AND user_id = ? AND lifted_at IS NULL',
      );
      expect(update?.values).toEqual([
        'admin-id',
        'Appeal accepted',
        'restriction-1',
        'target-id',
      ]);
      expect(result).toMatchObject({
        id: 'restriction-1',
        lift_reason: 'Appeal accepted',
        lifted_by_username: 'admin',
        active: false,
      });
      expect(result.lifted_at).not.toBeNull();
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0][3]).toBe('restriction_lifted');
      expect(auditRows[0][4]).toBe('restriction');
      expect(auditRows[0][5]).toBe('restriction-1');
      expect(JSON.parse(String(auditRows[0][6]))).toEqual({
        restriction_id: 'restriction-1',
        restriction_type: 'suspension',
      });
      expect(events).toEqual(['audit', 'commit']);
      expect(logoutAll).not.toHaveBeenCalled();
    });

    it('returns 409 for an already lifted restriction', async () => {
      restrictions[0].lifted_at = new Date();

      await expect(
        service.lift(
          'target-id',
          'restriction-1',
          { lift_reason: 'X' },
          'admin-id',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(auditRows).toHaveLength(0);
      expect(transaction).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });

    it('returns 404 for an unknown id or another user’s restriction', async () => {
      await expect(
        service.lift('target-id', 'missing', { lift_reason: 'X' }, 'admin-id'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.lift(
          'moderator-id',
          'restriction-1',
          { lift_reason: 'X' },
          'admin-id',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(restrictions[0].lifted_at).toBeNull();
    });

    it('lifts an expired suspension to close the case', async () => {
      restrictions[0].expires_at = new Date(Date.now() - 60_000);

      await expect(
        service.lift(
          'target-id',
          'restriction-1',
          { lift_reason: 'Closed' },
          'admin-id',
        ),
      ).resolves.toMatchObject({ active: false, lift_reason: 'Closed' });
    });

    it('rolls back the lift when the audit write fails', async () => {
      failAudit = true;

      await expect(
        service.lift(
          'target-id',
          'restriction-1',
          { lift_reason: 'X' },
          'admin-id',
        ),
      ).rejects.toThrow('Audit insert failed');
      expect(restrictions[0].lifted_at).toBeNull();
      expect(transaction).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });
  });

  describe('findAll', () => {
    it('returns paginated history newest first with active flags', async () => {
      restrictions.push(
        fixture({
          id: 'old',
          created_at: new Date('2026-01-01T00:00:00Z'),
          expires_at: new Date('2026-01-02T00:00:00Z'),
        }),
        fixture({
          id: 'lifted',
          type: 'ban',
          created_at: new Date('2026-02-01T00:00:00Z'),
          expires_at: null,
          lifted_at: new Date('2026-02-02T00:00:00Z'),
          lifted_by: 'admin-id',
          lift_reason: 'Appeal',
        }),
        fixture({
          id: 'current',
          created_at: new Date('2026-03-01T00:00:00Z'),
        }),
      );

      const first = await service.findAll('target-id', { page: 1, limit: 2 });
      const second = await service.findAll('target-id', { page: 2, limit: 2 });

      expect(first.items.map((item) => [item.id, item.active])).toEqual([
        ['current', true],
        ['lifted', false],
      ]);
      expect(second.items.map((item) => [item.id, item.active])).toEqual([
        ['old', false],
      ]);
      expect(first).toMatchObject({ page: 1, limit: 2, total: 3 });
      const listQuery = calls.find((call) =>
        call.sql.startsWith('SELECT r.id'),
      );
      expect(listQuery?.sql).toContain('ORDER BY r.created_at DESC, r.id DESC');
      expect(listQuery?.sql).toContain('AS active');
    });

    it('returns an empty page for an account without restrictions', async () => {
      await expect(
        service.findAll('target-id', { page: 1, limit: 20 }),
      ).resolves.toEqual({ items: [], page: 1, limit: 20, total: 0 });
    });

    it('returns 404 for an unknown user', async () => {
      await expect(
        service.findAll('missing-id', { page: 1, limit: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps rows whose acting administrators were deleted', async () => {
      restrictions.push(
        fixture({
          created_by: null,
          lifted_at: new Date(),
          lifted_by: null,
          lift_reason: 'Closed',
        }),
      );

      const result = await service.findAll('target-id', { page: 1, limit: 20 });

      expect(result.items[0]).toMatchObject({
        created_by_username: null,
        lifted_by_username: null,
        lift_reason: 'Closed',
      });
    });
  });

  it('maps database booleans and timestamps to the response shape', () => {
    const dto = toAdminRestrictionDto({
      id: 'r',
      type: 'ban',
      reason: 'X',
      created_by_username: null,
      created_at: '2026-01-01 00:00:00Z',
      expires_at: null,
      lifted_at: null,
      lifted_by_username: null,
      lift_reason: null,
      report_id: null,
      active: '1',
    } as RestrictionRecord);

    expect(dto).toEqual({
      id: 'r',
      type: 'ban',
      reason: 'X',
      created_by_username: null,
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: null,
      lifted_at: null,
      lifted_by_username: null,
      lift_reason: null,
      report_id: null,
      active: true,
    });
  });
});
