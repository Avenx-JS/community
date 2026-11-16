import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { ACTIVE_COMMUNITY_BAN_SQL } from '../common/active-community-ban';
import type { NotificationsService } from '../notifications/notifications.service';
import { CREATED_COMMUNITY_SQL } from '../users/account-deletion.service';
import {
  CommunitiesService,
  OWNER_USERNAME_SQL,
  REMOVE_MODERATOR_SQL,
  TRANSFER_CREATOR_SQL,
  TRANSFER_TARGET_MODERATOR_SQL,
  TRANSFER_TARGET_RESTRICTION_SQL,
  TRANSFER_TARGET_SQL,
} from './communities.service';
import type { CommunityBanPolicyService } from './community-ban-policy.service';
import type { CommunityModerationLogService } from './community-moderation-log.service';
import { INSERT_MODERATOR_SQL } from './community-moderator-invites.service';
import type { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';

const COMMUNITY = { id: 'k-1', creator_id: 'founder', visibility: 'public' };

describe('CommunitiesService.transferOwnership', () => {
  let service: CommunitiesService;
  let community: typeof COMMUNITY | undefined;
  let target: Record<string, unknown> | undefined;
  let restricted: boolean;
  let banned: boolean;
  let moderator: boolean;
  let moved: number;
  let log: string[];
  let calls: Array<{ sql: string; values: unknown[] }>;
  let moderationLog: { record: jest.Mock };
  let notifications: { record: jest.Mock };

  beforeEach(() => {
    community = { ...COMMUNITY };
    target = { id: 'heir', username: 'heir_1', deleted_at: null };
    restricted = false;
    banned = false;
    moderator = true;
    moved = 1;
    log = [];
    calls = [];
    const rows = (value: unknown) => Promise.resolve([value, []]);
    const execute = (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      log.push(sql);
      if (
        sql.startsWith('SELECT id, creator_id, visibility FROM communities')
      ) {
        return rows(community ? [community] : []);
      }
      if (sql === TRANSFER_TARGET_SQL) return rows(target ? [target] : []);
      if (sql === TRANSFER_TARGET_RESTRICTION_SQL) {
        return rows(restricted ? [{ id: 'r-1' }] : []);
      }
      if (sql === ACTIVE_COMMUNITY_BAN_SQL) {
        return rows(banned ? [{ id: 'b-1' }] : []);
      }
      if (sql === TRANSFER_TARGET_MODERATOR_SQL) {
        return rows(moderator ? [{ user_id: 'heir' }] : []);
      }
      if (sql === TRANSFER_CREATOR_SQL) return rows({ affectedRows: moved });
      if (sql === OWNER_USERNAME_SQL) return rows([{ username: 'founder_1' }]);
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
    moderationLog = {
      record: jest.fn(() => {
        log.push('log');
        return Promise.resolve();
      }),
    };
    notifications = {
      record: jest.fn(() => {
        log.push('notify');
        return Promise.resolve();
      }),
    };
    service = new CommunitiesService(
      {
        execute,
        getConnection: () => Promise.resolve(connection),
      } as unknown as Pool,
      {} as CommunityRuleAcceptanceService,
      moderationLog as unknown as CommunityModerationLogService,
      {} as CommunityBanPolicyService,
      notifications as unknown as NotificationsService,
    );
  });

  const transfer = (
    body: Partial<{ username: string; confirm_name: string }> = {},
    actor = 'founder',
  ) =>
    service.transferOwnership(
      'garden',
      { username: 'heir_1', confirm_name: 'garden', ...body },
      actor,
    );
  const writes = () =>
    calls.filter(({ sql }) => /^(UPDATE|INSERT|DELETE)/.test(sql));

  it('hands the community to a moderator, keeps the former owner as a moderator, logs and notifies, in one transaction', async () => {
    await expect(transfer()).resolves.toBeUndefined();

    expect(log).toEqual([
      'begin',
      expect.stringMatching(/FROM communities WHERE name = \? .* FOR UPDATE$/),
      TRANSFER_TARGET_SQL,
      TRANSFER_TARGET_RESTRICTION_SQL,
      ACTIVE_COMMUNITY_BAN_SQL,
      TRANSFER_TARGET_MODERATOR_SQL,
      TRANSFER_CREATOR_SQL,
      REMOVE_MODERATOR_SQL,
      INSERT_MODERATOR_SQL,
      'log',
      OWNER_USERNAME_SQL,
      'notify',
      'commit',
      'release',
    ]);
    expect(writes()).toEqual([
      { sql: TRANSFER_CREATOR_SQL, values: ['heir', 'k-1', 'founder'] },
      // The new owner's moderator row goes: the creator holds those powers.
      { sql: REMOVE_MODERATOR_SQL, values: ['k-1', 'heir'] },
      // The former owner stays, assigned by the new owner.
      { sql: INSERT_MODERATOR_SQL, values: ['k-1', 'founder', 'heir'] },
    ]);
    expect(moderationLog.record).toHaveBeenCalledWith(expect.anything(), {
      actorId: 'founder',
      communityId: 'k-1',
      action: 'ownership_transferred',
      targetType: 'user',
      targetId: 'heir',
      metadata: { username: 'heir_1' },
    });
    expect(notifications.record).toHaveBeenCalledWith(expect.anything(), {
      recipientId: 'heir',
      type: 'community_ownership_transferred',
      actorId: 'founder',
      subjectType: 'community',
      subjectId: 'k-1',
      communityId: 'k-1',
      metadata: { actor_username: 'founder_1', community_name: 'garden' },
    });
  });

  it('re-checks the owner on the locked row when it moves', () => {
    expect(TRANSFER_CREATOR_SQL).toBe(
      'UPDATE communities SET creator_id = ? WHERE id = ? AND creator_id = ?',
    );
    expect(TRANSFER_TARGET_MODERATOR_SQL).toMatch(/FOR UPDATE$/);
  });

  // The account-deletion check reads the column the transfer rewrites, so a
  // former owner is no longer refused for this community.
  it('frees the former owner from the account-deletion check', () => {
    expect(CREATED_COMMUNITY_SQL).toBe(
      'SELECT id FROM communities WHERE creator_id = ? AND deleted_at IS NULL LIMIT 1',
    );
  });

  describe('refusals, each writing nothing', () => {
    const refused = async (
      act: () => Promise<void>,
      type: new (...args: never[]) => Error,
      message?: string,
    ) => {
      const result = act();
      await expect(result).rejects.toBeInstanceOf(type);
      if (message) await expect(result).rejects.toThrow(message);
      expect(writes()).toEqual([]);
      expect(moderationLog.record).not.toHaveBeenCalled();
      expect(notifications.record).not.toHaveBeenCalled();
    };

    it('400 for a mismatched confirmation, before any query', async () => {
      await refused(
        () => transfer({ confirm_name: 'Garden' }),
        BadRequestException,
        'confirmation name',
      );
      expect(calls).toEqual([]);
    });

    it('404 for an unknown, deleted or suspended community, before 403', async () => {
      community = undefined;
      await refused(() => transfer({}, 'stranger'), NotFoundException);
    });

    it('403 unless the caller is the creator, a moderator included', async () => {
      await refused(
        () => transfer({}, 'heir'),
        ForbiddenException,
        'Only the community creator can transfer the community',
      );
      expect(log).toContain('rollback');
    });

    it('404 for an unknown user', async () => {
      target = undefined;
      await refused(() => transfer(), NotFoundException, 'User not found');
    });

    it('404 for a deleted user', async () => {
      target = { ...target, deleted_at: new Date() };
      await refused(() => transfer(), NotFoundException, 'User not found');
    });

    it('400 for a transfer to yourself', async () => {
      target = { id: 'founder', username: 'founder_1', deleted_at: null };
      await refused(
        () => transfer({ username: 'founder_1' }),
        BadRequestException,
        'already own',
      );
    });

    it('409 for a platform-restricted target', async () => {
      restricted = true;
      await refused(() => transfer(), ConflictException, 'suspended or banned');
    });

    it('409 for a target banned from the community', async () => {
      banned = true;
      await refused(
        () => transfer(),
        ConflictException,
        'banned from the community',
      );
    });

    it('409 for a target who is not a moderator', async () => {
      moderator = false;
      await refused(() => transfer(), ConflictException, 'current moderator');
    });

    it('409 when ownership moved concurrently, rolling back', async () => {
      moved = 0;
      const result = transfer();
      await expect(result).rejects.toBeInstanceOf(ConflictException);
      expect(moderationLog.record).not.toHaveBeenCalled();
      expect(log.slice(-2)).toEqual(['rollback', 'release']);
    });
  });

  it('rolls everything back when the notification cannot be written', async () => {
    notifications.record.mockImplementationOnce(() =>
      Promise.reject(new Error('notify failed')),
    );
    await expect(transfer()).rejects.toThrow('notify failed');
    expect(log.slice(-2)).toEqual(['rollback', 'release']);
    expect(log).not.toContain('commit');
  });
});
