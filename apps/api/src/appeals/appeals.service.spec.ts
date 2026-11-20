import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import type { AdminCommunitiesService } from '../admin/admin-communities.service';
import type { AdminContentService } from '../admin/admin-content.service';
import type { AdminRestrictionsService } from '../admin/admin-restrictions.service';
import type { AuditEntry, AuditLogService } from '../admin/audit-log.service';
import type { NotificationEntry } from '../notifications/notification-metadata';
import type { NotificationsService } from '../notifications/notifications.service';
import {
  AdminAppealsService,
  DECIDE_APPEAL_SQL,
  OTHER_ADMINS_SQL,
} from './admin-appeals.service';
import {
  existingAppealSql,
  insertAppealSql,
  lockAppealTargetSql,
  lockTargetSql,
} from './appeal-targets';
import { AppealsService, COMMUNITY_MODERATION_REASON } from './appeals.service';
import type { AppealTargetType } from './dto/appeals.dto';

type Handler = (values: unknown[]) => unknown;

// A pool and one connection over the same router: each test registers what
// a statement returns, by exact SQL or by prefix. Anything else fails.
function fakeDatabase() {
  const exact = new Map<string, Handler>();
  const prefixes: Array<[string, Handler]> = [];
  const calls: Array<{ sql: string; values: unknown[]; on: string }> = [];
  const transactions = { begun: 0, commits: 0, rollbacks: 0 };
  const route =
    (on: string) =>
    (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values, on });
      const handler =
        exact.get(sql) ??
        prefixes.find(([prefix]) => sql.startsWith(prefix))?.[1];
      if (!handler) {
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      }
      try {
        return Promise.resolve([handler(values), []]);
      } catch (error) {
        return Promise.reject(error as Error);
      }
    };
  const connection = {
    execute: route('connection'),
    beginTransaction: () => {
      transactions.begun += 1;
      return Promise.resolve();
    },
    commit: () => {
      transactions.commits += 1;
      return Promise.resolve();
    },
    rollback: () => {
      transactions.rollbacks += 1;
      return Promise.resolve();
    },
    release: () => undefined,
  };
  const pool = {
    execute: route('pool'),
    getConnection: () => Promise.resolve(connection),
  } as unknown as Pool;
  return {
    pool,
    connection,
    calls,
    transactions,
    on: (sql: string, handler: Handler) => exact.set(sql, handler),
    // The latest registration wins, so a test can override the default.
    onPrefix: (prefix: string, handler: Handler) =>
      prefixes.unshift([prefix, handler]),
  };
}

const target = (overrides: Record<string, unknown> = {}) => ({
  owner_id: 'u-1',
  in_force: 1,
  by_admin: 1,
  in_window: 1,
  community_name: null,
  ...overrides,
});

const appealRow = {
  id: 'appeal-1',
  target_type: 'restriction',
  target_id: 'r-1',
  reason: 'I did not spam anyone.',
  status: 'open',
  decision_note: null,
  created_at: new Date('2026-11-20T10:00:00.000Z'),
  decided_at: null,
};

describe('AppealsService', () => {
  let db: ReturnType<typeof fakeDatabase>;
  let service: AppealsService;
  const input = (target_type: AppealTargetType = 'restriction') => ({
    target_type,
    target_id: 'r-1',
    reason: 'I did not spam anyone.',
  });

  beforeEach(() => {
    db = fakeDatabase();
    service = new AppealsService(db.pool);
    db.on(existingAppealSql('restriction'), () => []);
    db.on(insertAppealSql('restriction'), () => ({ affectedRows: 1 }));
    db.onPrefix('SELECT id, target_type, target_id, reason', () => [appealRow]);
  });

  it('files an appeal of the caller’s own decision, copied from the locked row', async () => {
    db.on(lockAppealTargetSql('restriction'), () => [target()]);

    await expect(service.create('u-1', input())).resolves.toEqual({
      id: 'appeal-1',
      target_type: 'restriction',
      target_id: 'r-1',
      reason: 'I did not spam anyone.',
      status: 'open',
      decision_note: null,
      created_at: '2026-11-20T10:00:00.000Z',
      decided_at: null,
    });
    const statements = db.calls.map((call) => call.sql);
    // The lock comes first, so the transaction's snapshot follows it.
    expect(statements[0]).toBe(lockAppealTargetSql('restriction'));
    expect(db.calls[0].values).toEqual([30, 'r-1']);
    const insert = db.calls.find(
      (call) => call.sql === insertAppealSql('restriction'),
    );
    expect(insert?.values).toEqual([
      expect.any(String),
      'u-1',
      'restriction',
      'I did not spam anyone.',
      'r-1',
    ]);
    expect(db.transactions).toEqual({ begun: 1, commits: 1, rollbacks: 0 });
  });

  it.each([
    ['no such decision', []],
    ['another account’s decision', [target({ owner_id: 'u-2' })]],
  ])('answers 404 for %s', async (_case, rows) => {
    db.on(lockAppealTargetSql('restriction'), () => rows);
    await expect(service.create('u-1', input())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(db.transactions.rollbacks).toBe(1);
  });

  it('refuses a decision no longer in force', async () => {
    db.on(lockAppealTargetSql('restriction'), () => [
      target({ in_force: 0, in_window: null }),
    ]);
    await expect(service.create('u-1', input())).rejects.toThrow(
      'no longer in force',
    );
  });

  it('points a moderator’s removal to the community’s modmail', async () => {
    db.on(lockAppealTargetSql('post_removal'), () => [
      target({ by_admin: 0, community_name: 'cats' }),
    ]);
    const error = await service
      .create('u-1', input('post_removal'))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      reason: COMMUNITY_MODERATION_REASON,
      community_name: 'cats',
    });
  });

  it('refuses a decision older than the window', async () => {
    db.on(lockAppealTargetSql('restriction'), () => [target({ in_window: 0 })]);
    await expect(service.create('u-1', input())).rejects.toThrow(
      'can be appealed for 30 days',
    );
  });

  it('reads the window from APPEAL_WINDOW_DAYS', async () => {
    process.env.APPEAL_WINDOW_DAYS = '7';
    try {
      const configured = new AppealsService(db.pool);
      db.on(lockAppealTargetSql('restriction'), () => [target()]);
      await configured.create('u-1', input());
      expect(db.calls[0].values).toEqual([7, 'r-1']);
    } finally {
      delete process.env.APPEAL_WINDOW_DAYS;
    }
  });

  it('refuses a second appeal, by the check or by the unique keys', async () => {
    db.on(lockAppealTargetSql('restriction'), () => [target()]);
    db.on(existingAppealSql('restriction'), () => [
      { id: 'appeal-0', status: 'rejected' },
    ]);
    await expect(service.create('u-1', input())).rejects.toThrow(
      'already been appealed',
    );

    db.on(existingAppealSql('restriction'), () => []);
    db.on(insertAppealSql('restriction'), () => {
      throw Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' });
    });
    await expect(service.create('u-1', input())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('lists the caller’s appeals, newest first, paged', async () => {
    db.onPrefix('SELECT COUNT(*) AS total FROM appeals', () => [
      { total: '3' },
    ]);
    const list = await service.listOwn('u-1', { page: 2, limit: 1 });
    expect(list).toMatchObject({ page: 2, limit: 1, total: 3 });
    expect(list.items).toHaveLength(1);
    const select = db.calls.find((call) =>
      call.sql.startsWith('SELECT id, target_type'),
    );
    expect(select?.sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(select?.values).toEqual(['u-1', 1, 1]);
  });
});

describe('AdminAppealsService', () => {
  let db: ReturnType<typeof fakeDatabase>;
  let audits: AuditEntry[];
  let notified: NotificationEntry[];
  let restrictions: { liftWithin: jest.Mock };
  let content: {
    restorePostWithin: jest.Mock;
    restoreCommentWithin: jest.Mock;
    findPost: jest.Mock;
    findComment: jest.Mock;
  };
  let communities: { restoreWithin: jest.Mock; findOne: jest.Mock };
  let locked: Record<string, unknown>;
  let decided: number;
  let inForce: number;
  let otherAdmins: number;
  let service: AdminAppealsService;

  const detailRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'appeal-1',
    status: 'approved',
    target_type: 'restriction',
    target_id: 'r-1',
    reason: 'I did not spam anyone.',
    decision_note: 'Mistaken identity.',
    created_at: new Date('2026-11-20T10:00:00.000Z'),
    decided_at: new Date('2026-11-21T10:00:00.000Z'),
    user_id: 'u-1',
    username: 'user_1',
    decided_by: 'admin-2',
    decided_by_username: 'admin_2',
    original_actor_id: 'admin-1',
    original_actor_username: 'admin_1',
    original_reason: 'Spam',
    original_decided_at: new Date('2026-11-19T10:00:00.000Z'),
    restriction_type: 'suspension',
    restriction_expires_at: null,
    post_id: null,
    post_title: null,
    excerpt: null,
    community_id: null,
    community_name: null,
    in_force: 0,
    ...overrides,
  });

  const decide = (status: 'approved' | 'rejected' = 'approved') =>
    service.decide(
      'appeal-1',
      { status, decision_note: 'Mistaken identity.' },
      'admin-2',
    );

  const setTarget = (type: AppealTargetType, id: string) => {
    locked = { ...locked, target_type: type, target_id: id };
    db.onPrefix('SELECT target_type, target_id FROM appeals', () => [
      { target_type: type, target_id: id },
    ]);
    db.on(lockTargetSql(type), () => [{ id }]);
  };

  beforeEach(() => {
    db = fakeDatabase();
    audits = [];
    notified = [];
    restrictions = { liftWithin: jest.fn(() => Promise.resolve({})) };
    content = {
      restorePostWithin: jest.fn(() => Promise.resolve()),
      restoreCommentWithin: jest.fn(() => Promise.resolve()),
      findPost: jest.fn(() => Promise.reject(new NotFoundException())),
      findComment: jest.fn(() => Promise.resolve({ id: 'c-1' })),
    };
    communities = {
      restoreWithin: jest.fn(() => Promise.resolve()),
      findOne: jest.fn(() => Promise.resolve({ id: 'k-1' })),
    };
    locked = {
      id: 'appeal-1',
      user_id: 'u-1',
      status: 'open',
      original_actor_id: 'admin-1',
      appellant_deleted: 0,
    };
    decided = 1;
    inForce = 1;
    otherAdmins = 1;

    setTarget('restriction', 'r-1');
    db.onPrefix('SELECT a.id, a.user_id, a.target_type', () => [locked]);
    db.on(OTHER_ADMINS_SQL, () => [{ total: otherAdmins }]);
    db.on(DECIDE_APPEAL_SQL, () => ({ affectedRows: decided }));
    db.onPrefix('SELECT CASE a.target_type', () => [{ in_force: inForce }]);
    db.onPrefix('SELECT a.id, a.status', () => [detailRow()]);
    db.onPrefix('SELECT id, target_type, target_id, status', () => [
      {
        id: 'appeal-0',
        target_type: 'post_removal',
        target_id: 'p-0',
        status: 'rejected',
        created_at: new Date('2026-10-01T10:00:00.000Z'),
        decided_at: new Date('2026-10-02T10:00:00.000Z'),
      },
    ]);
    db.onPrefix('SELECT COUNT(*) AS total FROM appeals', () => [
      { total: '1' },
    ]);
    db.onPrefix('SELECT r.id, r.type', () => [
      {
        id: 'r-1',
        type: 'suspension',
        reason: 'Spam',
        created_by_username: 'admin_1',
        created_at: new Date('2026-11-19T10:00:00.000Z'),
        expires_at: null,
        lifted_at: new Date('2026-11-21T10:00:00.000Z'),
        lifted_by_username: 'admin_2',
        lift_reason: 'Mistaken identity.',
        report_id: null,
        active: 0,
      },
    ]);

    service = new AdminAppealsService(
      db.pool,
      {
        record: (_connection: unknown, entry: AuditEntry) => {
          audits.push(entry);
          return Promise.resolve();
        },
      } as unknown as AuditLogService,
      {
        record: (_connection: unknown, entry: NotificationEntry) => {
          notified.push(entry);
          return Promise.resolve();
        },
      } as unknown as NotificationsService,
      restrictions as unknown as AdminRestrictionsService,
      content as unknown as AdminContentService,
      communities as unknown as AdminCommunitiesService,
    );
  });

  it('lists the open queue oldest first by default', async () => {
    const list = await service.findAll({});
    const select = db.calls.find((call) =>
      call.sql.startsWith('SELECT a.id, a.status'),
    );
    expect(select?.sql).toContain('WHERE a.status = ?');
    expect(select?.sql).toContain('ORDER BY a.created_at ASC, a.id ASC');
    expect(select?.values).toEqual(['open', 20, 0]);
    expect(list.filters).toEqual({ status: 'open', target_type: null });
    expect(list.items[0]).toMatchObject({
      user: { id: 'u-1', username: 'user_1' },
      original_decision: {
        reason: 'Spam',
        actor_username: 'admin_1',
        decided_at: '2026-11-19T10:00:00.000Z',
      },
      target: { restriction_type: 'suspension', in_force: false },
    });
  });

  it('lists any status newest first, by target type', async () => {
    await service.findAll({ status: 'any', target_type: 'post_removal' });
    const select = db.calls.find((call) =>
      call.sql.startsWith('SELECT a.id, a.status'),
    );
    expect(select?.sql).not.toContain('a.status = ?');
    expect(select?.sql).toContain('ORDER BY a.created_at DESC, a.id DESC');
    expect(select?.values).toEqual(['post_removal', 20, 0]);
  });

  it('details the appeal with the target and the user’s other appeals', async () => {
    const detail = await service.findOne('appeal-1');
    expect(detail.restriction).toMatchObject({ id: 'r-1', active: false });
    expect(detail.post).toBeNull();
    expect(detail.prior_appeals).toEqual([
      {
        id: 'appeal-0',
        target_type: 'post_removal',
        target_id: 'p-0',
        status: 'rejected',
        created_at: '2026-10-01T10:00:00.000Z',
        decided_at: '2026-10-02T10:00:00.000Z',
      },
    ]);
    expect(detail.prior_appeal_count).toBe(1);
  });

  it('answers null for a target gone since', async () => {
    db.onPrefix('SELECT a.id, a.status', () => [
      detailRow({ target_type: 'post_removal', target_id: 'p-1' }),
    ]);
    await expect(service.findOne('appeal-1')).resolves.toMatchObject({
      post: null,
      restriction: null,
    });
  });

  it('approves, reversing the decision inside the transaction, then audits and notifies', async () => {
    await decide();

    expect(restrictions.liftWithin).toHaveBeenCalledWith(
      db.connection,
      'u-1',
      'r-1',
      'Mistaken identity.',
      'admin-2',
    );
    // The target is locked before the appeal, as filing does.
    const order = db.calls
      .filter((call) => call.on === 'connection')
      .map((call) => call.sql);
    expect(order[0]).toBe(lockTargetSql('restriction'));
    expect(order[1]).toMatch(/^SELECT a\.id, a\.user_id/);
    expect(
      db.calls.find((call) => call.sql === DECIDE_APPEAL_SQL)?.values,
    ).toEqual(['approved', 'Mistaken identity.', 'admin-2', 'appeal-1']);
    expect(audits).toEqual([
      {
        actorId: 'admin-2',
        action: 'appeal_approved',
        targetType: 'appeal',
        targetId: 'appeal-1',
        metadata: {
          appeal_target_type: 'restriction',
          appeal_target_id: 'r-1',
          decision_note: 'Mistaken identity.',
          reversed: 'true',
        },
      },
    ]);
    expect(notified).toEqual([
      {
        recipientId: 'u-1',
        type: 'appeal_decided',
        actorId: null,
        subjectType: 'appeal',
        subjectId: 'appeal-1',
        communityId: null,
        metadata: {
          status: 'approved',
          appeal_target_type: 'restriction',
          decision_note: 'Mistaken identity.',
        },
      },
    ]);
    expect(db.transactions).toEqual({ begun: 1, commits: 1, rollbacks: 0 });
  });

  it.each([
    ['post_removal', 'restorePostWithin'],
    ['comment_removal', 'restoreCommentWithin'],
  ] as const)(
    'reverses a %s through AdminContentService',
    async (type, method) => {
      setTarget(type, 'x-1');
      await decide();
      expect(content[method]).toHaveBeenCalledWith(
        db.connection,
        'x-1',
        'Mistaken identity.',
        'admin-2',
      );
    },
  );

  it('reverses a community suspension through AdminCommunitiesService', async () => {
    setTarget('community_suspension', 'k-1');
    await decide();
    expect(communities.restoreWithin).toHaveBeenCalledWith(
      db.connection,
      'k-1',
      'Mistaken identity.',
      'admin-2',
    );
  });

  it('approves without reversing a decision reversed or replaced meanwhile', async () => {
    inForce = 0;
    await decide();
    expect(restrictions.liftWithin).not.toHaveBeenCalled();
    expect(audits[0].metadata).toMatchObject({ reversed: 'false' });
    expect(db.transactions.commits).toBe(1);
  });

  it('rejects without reversing, and without the reversed flag', async () => {
    await decide('rejected');
    expect(restrictions.liftWithin).not.toHaveBeenCalled();
    expect(audits[0].action).toBe('appeal_rejected');
    expect(audits[0].metadata).not.toHaveProperty('reversed');
    expect(notified[0].metadata).toMatchObject({ status: 'rejected' });
  });

  it('rolls everything back when the reversal fails', async () => {
    setTarget('comment_removal', 'c-1');
    content.restoreCommentWithin.mockImplementation(() =>
      Promise.reject(new ConflictException('restore the post first')),
    );
    await expect(decide()).rejects.toBeInstanceOf(ConflictException);
    expect(audits).toEqual([]);
    expect(notified).toEqual([]);
    expect(db.transactions).toEqual({ begun: 1, commits: 0, rollbacks: 1 });
  });

  it('answers 404 for an unknown appeal, before any transaction', async () => {
    db.onPrefix('SELECT target_type, target_id FROM appeals', () => []);
    await expect(decide()).rejects.toBeInstanceOf(NotFoundException);
    expect(db.transactions.begun).toBe(0);
  });

  it('answers 409 for an appeal already decided, by the lock or the update', async () => {
    locked = { ...locked, status: 'rejected' };
    await expect(decide()).rejects.toThrow('already been decided');
    locked = { ...locked, status: 'open' };
    decided = 0;
    await expect(decide()).rejects.toThrow('already been decided');
    expect(restrictions.liftWithin).not.toHaveBeenCalled();
  });

  it.each([
    ['made the original decision', { original_actor_id: 'admin-2' }],
    ['filed the appeal', { user_id: 'admin-2' }],
  ])(
    'refuses an administrator who %s while another one exists',
    async (_case, overrides) => {
      locked = { ...locked, ...overrides };
      await expect(decide()).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        db.calls.find((call) => call.sql === OTHER_ADMINS_SQL)?.values,
      ).toEqual(['admin-2']);
      expect(db.calls.some((call) => call.sql === DECIDE_APPEAL_SQL)).toBe(
        false,
      );
    },
  );

  it('lets a sole administrator decide an appeal of their own decision', async () => {
    locked = { ...locked, original_actor_id: 'admin-2' };
    otherAdmins = 0;
    await expect(decide()).resolves.toMatchObject({ id: 'appeal-1' });
  });

  it('notifies no deleted account', async () => {
    locked = { ...locked, appellant_deleted: 1 };
    await decide();
    expect(notified).toEqual([]);
    expect(audits).toHaveLength(1);
  });
});
