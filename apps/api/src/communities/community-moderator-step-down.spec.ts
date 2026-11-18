import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { ALLOW_RESTRICTED } from '../auth/allow-restricted.decorator';
import type { NotificationsService } from '../notifications/notifications.service';
import { COMMUNITY_ROLE_BY_NAME_SQL } from './community-access';
import type { CommunityBanPolicyService } from './community-ban-policy.service';
import type { CommunityModerationLogService } from './community-moderation-log.service';
import {
  CommunityModeratorInvitesService,
  CREATOR_CANNOT_LEAVE_MESSAGE,
  LEAVE_MODERATION_SQL,
  MODERATOR_USERNAME_SQL,
} from './community-moderator-invites.service';
import { CommunitySettingsController } from './community-settings.controller';

describe('CommunityModeratorInvitesService.stepDown', () => {
  let service: CommunityModeratorInvitesService;
  let community: Record<string, unknown> | undefined;
  let removed: number;
  let log: string[];
  let calls: Array<{ sql: string; values: unknown[] }>;
  let moderationLog: { record: jest.Mock };
  let notifications: { record: jest.Mock };
  let bans: { assertNotBannedOrThrow: jest.Mock };

  beforeEach(() => {
    community = {
      id: 'k-1',
      name: 'garden',
      creator_id: 'founder',
      visibility: 'private',
      can_moderate: 1,
    };
    removed = 1;
    log = [];
    calls = [];
    const rows = (value: unknown) => Promise.resolve([value, []]);
    const execute = (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      log.push(sql);
      if (sql === `${COMMUNITY_ROLE_BY_NAME_SQL} FOR UPDATE`) {
        return rows(community ? [community] : []);
      }
      if (sql === LEAVE_MODERATION_SQL) return rows({ affectedRows: removed });
      if (sql === MODERATOR_USERNAME_SQL) return rows([{ username: 'mod_1' }]);
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
    bans = { assertNotBannedOrThrow: jest.fn() };
    service = new CommunityModeratorInvitesService(
      {
        execute,
        getConnection: () => Promise.resolve(connection),
      } as unknown as Pool,
      moderationLog as unknown as CommunityModerationLogService,
      bans as unknown as CommunityBanPolicyService,
      notifications as unknown as NotificationsService,
    );
  });

  it('removes the row on the locked community, logs moderator_left and notifies the creator', async () => {
    await expect(service.stepDown('garden', 'mod')).resolves.toBeUndefined();

    expect(log).toEqual([
      'begin',
      `${COMMUNITY_ROLE_BY_NAME_SQL} FOR UPDATE`,
      LEAVE_MODERATION_SQL,
      MODERATOR_USERNAME_SQL,
      'log',
      'notify',
      'commit',
      'release',
    ]);
    expect(calls[1]).toEqual({
      sql: LEAVE_MODERATION_SQL,
      values: ['k-1', 'mod'],
    });
    expect(moderationLog.record).toHaveBeenCalledWith(expect.anything(), {
      actorId: 'mod',
      communityId: 'k-1',
      action: 'moderator_left',
      targetType: 'user',
      targetId: 'mod',
      metadata: { username: 'mod_1' },
    });
    expect(notifications.record).toHaveBeenCalledWith(expect.anything(), {
      recipientId: 'founder',
      type: 'community_moderator_left',
      actorId: 'mod',
      subjectType: 'community',
      subjectId: 'k-1',
      communityId: 'k-1',
      metadata: { actor_username: 'mod_1', community_name: 'garden' },
    });
    // A community ban never keeps anyone in a role.
    expect(bans.assertNotBannedOrThrow).not.toHaveBeenCalled();
  });

  it('is idempotent: a caller who is not a moderator gets success and nothing is written', async () => {
    removed = 0;
    await expect(service.stepDown('garden', 'member')).resolves.toBeUndefined();
    expect(moderationLog.record).not.toHaveBeenCalled();
    expect(notifications.record).not.toHaveBeenCalled();
    expect(log.slice(-2)).toEqual(['commit', 'release']);
  });

  it('refuses the creator with 409, pointing at transfer and deletion', async () => {
    const result = service.stepDown('garden', 'founder');
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    await expect(result).rejects.toThrow(CREATOR_CANNOT_LEAVE_MESSAGE);
    expect(CREATOR_CANNOT_LEAVE_MESSAGE).toMatch(
      /POST \/communities\/\{name\}\/transfer.*delete/,
    );
    expect(calls.map(({ sql }) => sql)).not.toContain(LEAVE_MODERATION_SQL);
    expect(log.slice(-2)).toEqual(['rollback', 'release']);
  });

  it('answers 404 for an unknown, deleted or suspended community', async () => {
    community = undefined;
    await expect(service.stepDown('nope', 'mod')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(calls.map(({ sql }) => sql)).not.toContain(LEAVE_MODERATION_SQL);
  });

  it('rolls the removal back when the notification cannot be written', async () => {
    notifications.record.mockImplementationOnce(() =>
      Promise.reject(new Error('notify failed')),
    );
    await expect(service.stepDown('garden', 'mod')).rejects.toThrow(
      'notify failed',
    );
    expect(log.slice(-2)).toEqual(['rollback', 'release']);
  });

  // A suspended or banned account must still be able to give up a power.
  it('is open to platform-restricted callers', () => {
    expect(
      Reflect.getMetadata(
        ALLOW_RESTRICTED,
        Object.getOwnPropertyDescriptor(
          CommunitySettingsController.prototype,
          'stepDown',
        )?.value as object,
      ),
    ).toBe(true);
  });
});
