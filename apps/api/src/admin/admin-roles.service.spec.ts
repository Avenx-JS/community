import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { ACTIVE_ADMINS_SQL } from '../users/users.service';
import {
  ACTIVE_RESTRICTION_SQL,
  AdminRolesService,
  LOCK_ROLE_TARGET_SQL,
  ROLE_TARGET_SQL,
  SET_ROLE_SQL,
} from './admin-roles.service';
import type { AuditLogService } from './audit-log.service';

describe('AdminRolesService', () => {
  let service: AdminRolesService;
  let admins: Array<{ id: string }>;
  let target: Record<string, unknown> | undefined;
  let restricted: boolean;
  let log: string[];
  let calls: Array<{ sql: string; values: unknown[] }>;
  let audit: { record: jest.Mock };

  beforeEach(() => {
    admins = [{ id: 'admin-1' }, { id: 'admin-2' }];
    target = {
      id: 'user-1',
      username: 'sam',
      role: 'user',
      deleted_at: null,
    };
    restricted = false;
    log = [];
    calls = [];
    const execute = (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      log.push(sql);
      if (sql === ACTIVE_ADMINS_SQL) return Promise.resolve([admins, []]);
      if (sql === LOCK_ROLE_TARGET_SQL || sql === ROLE_TARGET_SQL) {
        return Promise.resolve([target ? [target] : [], []]);
      }
      if (sql === ACTIVE_RESTRICTION_SQL) {
        return Promise.resolve([restricted ? [{ id: 'r-1' }] : [], []]);
      }
      return Promise.resolve([{ affectedRows: 1 }, []]);
    };
    const connection = {
      beginTransaction: () => {
        log.push('begin');
        return Promise.resolve();
      },
      commit: () => {
        log.push('commit');
        return Promise.resolve();
      },
      rollback: () => {
        log.push('rollback');
        return Promise.resolve();
      },
      release: () => {
        log.push('release');
      },
      execute,
    };
    audit = {
      record: jest.fn(() => {
        log.push('audit');
        return Promise.resolve();
      }),
    };
    service = new AdminRolesService(
      {
        execute,
        getConnection: () => Promise.resolve(connection),
      } as unknown as Pool,
      audit as unknown as AuditLogService,
    );
  });

  const roleWrites = () => calls.filter(({ sql }) => sql === SET_ROLE_SQL);

  it('reads the one role, listing the elevated one', async () => {
    await expect(service.find('user-1')).resolves.toEqual({
      user_id: 'user-1',
      username: 'sam',
      role: 'user',
      roles: [],
    });
    target = { ...target, role: 'admin', deleted_at: new Date() };
    await expect(service.find('user-1')).resolves.toEqual({
      user_id: 'user-1',
      username: null,
      role: 'admin',
      roles: ['admin'],
    });
    target = undefined;
    await expect(service.find('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('assigns a role under the administrators lock, audited with the reason, in one transaction', async () => {
    await expect(
      service.assign('user-1', 'admin', 'Joins the trust team', 'admin-1'),
    ).resolves.toEqual({
      user_id: 'user-1',
      username: 'sam',
      role: 'admin',
      roles: ['admin'],
    });
    expect(log).toEqual([
      'begin',
      ACTIVE_ADMINS_SQL,
      LOCK_ROLE_TARGET_SQL,
      ACTIVE_RESTRICTION_SQL,
      SET_ROLE_SQL,
      'audit',
      'commit',
      'release',
    ]);
    expect(roleWrites()).toEqual([
      { sql: SET_ROLE_SQL, values: ['admin', 'user-1'] },
    ]);
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), {
      actorId: 'admin-1',
      action: 'user_role_changed',
      targetType: 'user',
      targetId: 'user-1',
      metadata: {
        from_role: 'user',
        to_role: 'admin',
        reason: 'Joins the trust team',
      },
    });
  });

  it('replaces the other elevated role', async () => {
    target = { ...target, role: 'moderator' };
    await service.assign('user-1', 'admin', 'Promoted', 'admin-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: {
          from_role: 'moderator',
          to_role: 'admin',
          reason: 'Promoted',
        },
      }),
    );
  });

  it('revokes a held role back to user', async () => {
    target = { ...target, role: 'admin' };
    await expect(
      service.revoke('user-1', 'admin', 'Left the team', 'admin-1'),
    ).resolves.toMatchObject({ role: 'user', roles: [] });
    expect(roleWrites()).toEqual([
      { sql: SET_ROLE_SQL, values: ['user', 'user-1'] },
    ]);
  });

  describe('against privilege escalation', () => {
    it.each([
      ['assign', () => service.assign('admin-1', 'moderator', 'x', 'admin-1')],
      ['revoke', () => service.revoke('admin-1', 'admin', 'x', 'admin-1')],
    ])(
      'refuses to %s the caller’s own role, before any query',
      async (_, act) => {
        await expect(act()).rejects.toBeInstanceOf(ForbiddenException);
        expect(calls).toEqual([]);
      },
    );

    // A concurrent demotion committed first: the locked read no longer lists
    // the caller, who may not act on a role they just lost.
    it('refuses a caller who is no longer an administrator under the lock', async () => {
      admins = [{ id: 'admin-2' }];
      await expect(
        service.assign('user-1', 'admin', 'x', 'admin-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(roleWrites()).toEqual([]);
      expect(log.slice(-2)).toEqual(['rollback', 'release']);
    });

    it('refuses to make a suspended or banned account an administrator', async () => {
      restricted = true;
      await expect(
        service.assign('user-1', 'admin', 'x', 'admin-1'),
      ).rejects.toThrow('cannot become an administrator');
      expect(roleWrites()).toEqual([]);
    });

    it('lets a restricted account become a platform moderator', async () => {
      restricted = true;
      await service.assign('user-1', 'moderator', 'x', 'admin-1');
      expect(calls.map(({ sql }) => sql)).not.toContain(ACTIVE_RESTRICTION_SQL);
    });

    it.each(['user', 'owner', 'ADMIN'])(
      'rejects revoking %s with 400',
      async (role) => {
        await expect(
          service.revoke('user-1', role, 'x', 'admin-1'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(calls).toEqual([]);
      },
    );
  });

  describe('the last administrator', () => {
    // Unreachable through the self-check today; kept so the rule holds even
    // if that check ever changes.
    it.each([
      ['revoked', () => service.revoke('user-1', 'admin', 'x', 'admin-1')],
      ['demoted', () => service.assign('user-1', 'moderator', 'x', 'admin-1')],
    ])('cannot be %s', async (_, act) => {
      admins = [{ id: 'admin-1' }];
      target = { ...target, id: 'user-1', role: 'admin' };
      await expect(act()).rejects.toThrow(
        'The last platform administrator cannot be removed',
      );
      expect(roleWrites()).toEqual([]);
    });
  });

  it.each([
    ['already holds the role', { role: 'admin' }, ConflictException],
    ['is deleted', { deleted_at: new Date() }, ConflictException],
  ])('answers 409 when the account %s', async (_, change, type) => {
    target = { ...target, ...change };
    await expect(
      service.assign('user-1', 'admin', 'x', 'admin-1'),
    ).rejects.toBeInstanceOf(type);
    expect(roleWrites()).toEqual([]);
  });

  it('answers 404 for an unknown account or a role not held', async () => {
    await expect(
      service.revoke('user-1', 'moderator', 'x', 'admin-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    target = undefined;
    await expect(
      service.assign('nope', 'moderator', 'x', 'admin-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(roleWrites()).toEqual([]);
  });

  it('rolls the change back when the audit entry fails', async () => {
    audit.record.mockImplementationOnce(() =>
      Promise.reject(new Error('audit failed')),
    );
    await expect(
      service.assign('user-1', 'moderator', 'x', 'admin-1'),
    ).rejects.toThrow('audit failed');
    expect(log.slice(-2)).toEqual(['rollback', 'release']);
  });

  // The guard and the role routes agree on what an administrator is.
  it('counts only accounts that are not deleted, in a fixed lock order', () => {
    expect(ACTIVE_ADMINS_SQL).toBe(
      "SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY id FOR UPDATE",
    );
  });
});
