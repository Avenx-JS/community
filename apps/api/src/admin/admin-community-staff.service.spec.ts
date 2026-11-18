import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { ACTIVE_COMMUNITY_BAN_SQL } from '../common/active-community-ban';
import {
  REMOVE_MODERATOR_SQL,
  TRANSFER_CREATOR_SQL,
  TRANSFER_TARGET_MODERATOR_SQL,
} from '../communities/communities.service';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import {
  DELETE_MODERATOR_INVITE_SQL,
  INSERT_MODERATOR_SQL,
} from '../communities/community-moderator-invites.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { AdminCommunitiesService } from './admin-communities.service';
import {
  AdminCommunityStaffService,
  LOCK_STAFF_COMMUNITY_SQL,
  PREVIOUS_OWNER_SQL,
  STAFF_TARGET_SQL,
} from './admin-community-staff.service';
import { ACTIVE_RESTRICTION_SQL } from './admin-roles.service';
import type { AuditLogService } from './audit-log.service';

const REASON = 'Owner banned; the moderators asked for help';

describe('AdminCommunityStaffService', () => {
  let service: AdminCommunityStaffService;
  let community: Record<string, unknown> | undefined;
  let users: Record<string, Record<string, unknown>>;
  let previous: Record<string, unknown> | undefined;
  let restricted: Set<string>;
  let banned: Set<string>;
  let moderators: Set<string>;
  let log: string[];
  let calls: Array<{ sql: string; values: unknown[] }>;
  let audit: { record: jest.Mock };
  let moderationLog: { record: jest.Mock };
  let notifications: { record: jest.Mock };
  let findOne: jest.Mock;

  beforeEach(() => {
    community = {
      id: 'k-1',
      name: 'garden',
      creator_id: 'founder',
      deleted_at: null,
    };
    users = {
      heir: { id: 'heir', username: 'heir', deleted_at: null },
      member: { id: 'member', username: 'member', deleted_at: null },
      founder: { id: 'founder', username: 'founder', deleted_at: null },
      gone: { id: 'gone', username: 'deleted_gone', deleted_at: new Date() },
    };
    previous = {
      id: 'founder',
      username: 'founder',
      deleted_at: null,
      banned: 0,
    };
    restricted = new Set();
    banned = new Set();
    moderators = new Set(['heir']);
    log = [];
    calls = [];
    const rows = (value: unknown) => Promise.resolve([value, []]);
    const execute = (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      log.push(sql);
      const [first, second] = values as string[];
      if (sql === LOCK_STAFF_COMMUNITY_SQL)
        return rows(community ? [community] : []);
      if (sql === STAFF_TARGET_SQL) {
        return rows(
          Object.values(users).filter((user) => user.username === first),
        );
      }
      if (sql === ACTIVE_RESTRICTION_SQL) {
        return rows(restricted.has(first) ? [{ id: 'r' }] : []);
      }
      if (sql === ACTIVE_COMMUNITY_BAN_SQL) {
        return rows(banned.has(second) ? [{ id: 'b' }] : []);
      }
      if (sql === PREVIOUS_OWNER_SQL) return rows(previous ? [previous] : []);
      if (sql === TRANSFER_TARGET_MODERATOR_SQL) {
        return rows(moderators.has(second) ? [{ user_id: second }] : []);
      }
      if (sql === REMOVE_MODERATOR_SQL) {
        return rows({ affectedRows: moderators.delete(second) ? 1 : 0 });
      }
      return rows({ affectedRows: 1 });
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
    const recorder = (name: string) =>
      jest.fn(() => {
        log.push(name);
        return Promise.resolve();
      });
    audit = { record: recorder('audit') };
    moderationLog = { record: recorder('modlog') };
    notifications = { record: recorder('notify') };
    findOne = jest.fn(() => Promise.resolve({ id: 'k-1' }));
    service = new AdminCommunityStaffService(
      {
        execute,
        getConnection: () => Promise.resolve(connection),
      } as unknown as Pool,
      audit as unknown as AuditLogService,
      moderationLog as unknown as CommunityModerationLogService,
      notifications as unknown as NotificationsService,
      { findOne } as unknown as AdminCommunitiesService,
    );
  });

  const writes = () =>
    calls.filter(({ sql }) => /^(UPDATE|INSERT|DELETE)/.test(sql));
  const notified = () =>
    notifications.record.mock.calls.map(
      ([, entry]) => entry as { recipientId: string; type: string },
    );

  describe('changeOwner', () => {
    it('moves ownership, keeps the previous owner as a moderator, records both logs with the reason, and notifies both', async () => {
      await expect(
        service.changeOwner(
          'k-1',
          { username: 'heir', reason: REASON },
          'admin',
        ),
      ).resolves.toEqual({ id: 'k-1' });

      expect(writes()).toEqual([
        { sql: TRANSFER_CREATOR_SQL, values: ['heir', 'k-1', 'founder'] },
        { sql: REMOVE_MODERATOR_SQL, values: ['k-1', 'heir'] },
        { sql: DELETE_MODERATOR_INVITE_SQL, values: ['k-1', 'heir'] },
        { sql: INSERT_MODERATOR_SQL, values: ['k-1', 'founder', 'admin'] },
      ]);
      expect(audit.record).toHaveBeenCalledWith(expect.anything(), {
        actorId: 'admin',
        action: 'community_owner_changed',
        targetType: 'community',
        targetId: 'k-1',
        metadata: {
          community_name: 'garden',
          username: 'heir',
          previous_owner_username: 'founder',
          reason: REASON,
        },
      });
      expect(moderationLog.record).toHaveBeenCalledWith(expect.anything(), {
        actorId: 'admin',
        communityId: 'k-1',
        action: 'admin_owner_changed',
        targetType: 'user',
        targetId: 'heir',
        metadata: { username: 'heir', reason: REASON },
      });
      expect(notifications.record).toHaveBeenCalledWith(expect.anything(), {
        recipientId: 'heir',
        type: 'community_ownership_assigned',
        actorId: null,
        subjectType: 'community',
        subjectId: 'k-1',
        communityId: 'k-1',
        metadata: { community_name: 'garden' },
      });
      expect(notified()).toEqual([
        expect.objectContaining({
          recipientId: 'heir',
          type: 'community_ownership_assigned',
        }),
        expect.objectContaining({
          recipientId: 'founder',
          type: 'community_ownership_revoked',
        }),
      ]);
      expect(log.at(-2)).toBe('commit');
    });

    // Unlike the self-service transfer: the administrator decides.
    it('accepts an account that is not a moderator', async () => {
      await service.changeOwner(
        'k-1',
        { username: 'member', reason: REASON },
        'admin',
      );
      expect(writes()[0]).toEqual({
        sql: TRANSFER_CREATOR_SQL,
        values: ['member', 'k-1', 'founder'],
      });
    });

    it.each([
      ['banned from the platform', { banned: 1 }, true],
      ['deleted', { deleted_at: new Date() }, false],
    ])(
      'keeps no moderator row for a previous owner who is %s',
      async (_, change, notifiedPrevious) => {
        previous = { ...previous, ...change };
        await service.changeOwner(
          'k-1',
          { username: 'heir', reason: REASON },
          'admin',
        );
        expect(writes().map(({ sql }) => sql)).not.toContain(
          INSERT_MODERATOR_SQL,
        );
        expect(
          notified().some(({ recipientId }) => recipientId === 'founder'),
        ).toBe(notifiedPrevious);
      },
    );

    it('checks a platform ban of the previous owner with the shared predicate', () => {
      expect(PREVIOUS_OWNER_SQL).toContain("r.type = 'ban'");
      expect(PREVIOUS_OWNER_SQL).toContain(
        'lifted_at IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())',
      );
    });
  });

  describe('refusals, writing nothing', () => {
    const expectNothing = () => {
      expect(writes()).toEqual([]);
      expect(audit.record).not.toHaveBeenCalled();
      expect(moderationLog.record).not.toHaveBeenCalled();
      expect(notifications.record).not.toHaveBeenCalled();
    };
    const owner = (username: string) =>
      service.changeOwner('k-1', { username, reason: REASON }, 'admin');
    const add = (username: string) =>
      service.addModerator('k-1', { username, reason: REASON }, 'admin');

    it('404 for an unknown community', async () => {
      community = undefined;
      await expect(owner('heir')).rejects.toBeInstanceOf(NotFoundException);
      await expect(add('heir')).rejects.toBeInstanceOf(NotFoundException);
      expectNothing();
    });

    it('409 for a deleted community', async () => {
      community = { ...community, deleted_at: new Date() };
      await expect(owner('heir')).rejects.toBeInstanceOf(ConflictException);
      expectNothing();
    });

    it.each(['nobody', 'deleted_gone'])(
      '404 for the account %s',
      async (name) => {
        await expect(owner(name)).rejects.toBeInstanceOf(NotFoundException);
        await expect(add(name)).rejects.toBeInstanceOf(NotFoundException);
        expectNothing();
      },
    );

    it('409 for the current owner', async () => {
      await expect(owner('founder')).rejects.toThrow('already owns');
      await expect(add('founder')).rejects.toThrow('already runs');
      expectNothing();
    });

    it('409 for a platform-restricted account', async () => {
      restricted.add('heir');
      await expect(owner('heir')).rejects.toThrow('suspended or banned');
      await expect(add('heir')).rejects.toThrow('suspended or banned');
      expectNothing();
    });

    it('409 for an account banned from the community', async () => {
      banned.add('member');
      await expect(owner('member')).rejects.toThrow(
        'banned from the community',
      );
      await expect(add('member')).rejects.toThrow('banned from the community');
      expectNothing();
    });
  });

  describe('addModerator', () => {
    it('adds without an invitation, consumes a pending one, records both logs and notifies', async () => {
      await service.addModerator(
        'k-1',
        { username: 'member', reason: REASON },
        'admin',
      );
      expect(writes()).toEqual([
        { sql: INSERT_MODERATOR_SQL, values: ['k-1', 'member', 'admin'] },
        { sql: DELETE_MODERATOR_INVITE_SQL, values: ['k-1', 'member'] },
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'community_moderator_added',
          metadata: {
            community_name: 'garden',
            username: 'member',
            reason: REASON,
          },
        }),
      );
      expect(moderationLog.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'admin_moderator_added',
          targetId: 'member',
          metadata: { username: 'member', reason: REASON },
        }),
      );
      expect(notified()).toEqual([
        expect.objectContaining({
          recipientId: 'member',
          type: 'community_moderator_assigned',
        }),
      ]);
    });

    it('is idempotent for an existing moderator', async () => {
      await service.addModerator(
        'k-1',
        { username: 'heir', reason: REASON },
        'admin',
      );
      expect(writes()).toEqual([]);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('removeModerator', () => {
    it('removes, recording both logs with the reason', async () => {
      await service.removeModerator('k-1', 'heir', REASON, 'admin');
      expect(writes()).toEqual([
        { sql: REMOVE_MODERATOR_SQL, values: ['k-1', 'heir'] },
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'community_moderator_removed' }),
      );
      expect(moderationLog.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'admin_moderator_removed',
          metadata: { username: 'heir', reason: REASON },
        }),
      );
      expect(notifications.record).not.toHaveBeenCalled();
    });

    it('is idempotent for an account that is not a moderator', async () => {
      await service.removeModerator('k-1', 'member', REASON, 'admin');
      expect(audit.record).not.toHaveBeenCalled();
      expect(moderationLog.record).not.toHaveBeenCalled();
    });

    // A deleted account's placeholder is not a username the log accepts.
    it('clears out a deleted account, naming it by id only in the community log', async () => {
      moderators.add('gone');
      await service.removeModerator('k-1', 'deleted_gone', REASON, 'admin');
      expect(moderationLog.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          targetId: 'gone',
          metadata: { reason: REASON },
        }),
      );
    });

    it('refuses the owner, pointing at the owner route', async () => {
      await expect(
        service.removeModerator('k-1', 'founder', REASON, 'admin'),
      ).rejects.toThrow('POST /admin/communities/{id}/owner');
      expect(writes()).toEqual([]);
    });

    it('404 for an unknown account', async () => {
      await expect(
        service.removeModerator('k-1', 'nobody', REASON, 'admin'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('rolls everything back when an audit entry cannot be written', async () => {
    audit.record.mockImplementationOnce(() =>
      Promise.reject(new Error('audit failed')),
    );
    await expect(
      service.changeOwner('k-1', { username: 'heir', reason: REASON }, 'admin'),
    ).rejects.toThrow('audit failed');
    expect(log.slice(-2)).toEqual(['rollback', 'release']);
  });
});
