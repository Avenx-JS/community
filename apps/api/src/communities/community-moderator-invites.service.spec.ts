import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { COMMUNITY_ROLE_BY_NAME_SQL } from './community-access';
import type { CommunityBanPolicyService } from './community-ban-policy.service';
import type { CommunityModerationLogService } from './community-moderation-log.service';
import {
  CommunityModeratorInvitesService,
  DELETE_MODERATOR_INVITE_SQL,
  INSERT_MODERATOR_INVITE_SQL,
  INSERT_MODERATOR_SQL,
  INVITEE_SQL,
  IS_MODERATOR_SQL,
  IS_SUBSCRIBED_SQL,
  LOCK_MODERATOR_INVITE_SQL,
} from './community-moderator-invites.service';

type Answer = unknown[] | { affectedRows: number };

describe('CommunityModeratorInvitesService', () => {
  let statements: Array<{ sql: string; values: unknown[] }>;
  let answers: Map<string, Answer>;
  let record: jest.Mock;
  let banned: boolean;
  let service: CommunityModeratorInvitesService;

  beforeEach(() => {
    statements = [];
    banned = false;
    answers = new Map<string, Answer>([
      [INVITEE_SQL, [{ id: 'sam-id', username: 'sam' }]],
      [IS_SUBSCRIBED_SQL, [{ subscribed: 1 }]],
      [INSERT_MODERATOR_INVITE_SQL, { affectedRows: 1 }],
      [DELETE_MODERATOR_INVITE_SQL, { affectedRows: 1 }],
    ]);
    const execute = (sql: string, values: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith(COMMUNITY_ROLE_BY_NAME_SQL)) {
        return Promise.resolve([
          [
            {
              id: 'c-1',
              name: 'garden',
              creator_id: 'creator',
              visibility: 'public',
              can_moderate: values[0] === 'creator' ? 1 : 0,
            },
          ],
          [],
        ]);
      }
      if (sql === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
        return Promise.resolve([[{ username: 'sam' }], []]);
      }
      return Promise.resolve([answers.get(sql) ?? [], []]);
    };
    const connection = {
      execute,
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
    };
    record = jest.fn(() => Promise.resolve());
    service = new CommunityModeratorInvitesService(
      {
        execute,
        getConnection: () => Promise.resolve(connection),
      } as unknown as Pool,
      { record } as unknown as CommunityModerationLogService,
      {
        assertNotBannedOrThrow: () =>
          banned
            ? Promise.reject(new ForbiddenException({ reason: 'banned' }))
            : Promise.resolve(),
      } as unknown as CommunityBanPolicyService,
    );
  });

  const sqls = () => statements.map(({ sql }) => sql);

  it('invites a subscribed member and logs it, appointing nobody', async () => {
    await service.invite('garden', 'sam', 'creator');

    expect(
      statements.find(({ sql }) => sql === INSERT_MODERATOR_INVITE_SQL)?.values,
    ).toEqual(['c-1', 'sam-id', 'creator']);
    expect(sqls()).not.toContain(INSERT_MODERATOR_SQL);
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      actorId: 'creator',
      communityId: 'c-1',
      action: 'moderator_invited',
      targetType: 'user',
      targetId: 'sam-id',
      metadata: { username: 'sam' },
    });
  });

  it('logs a repeated invitation once', async () => {
    answers.set(INSERT_MODERATOR_INVITE_SQL, { affectedRows: 0 });
    await service.invite('garden', 'sam', 'creator');
    expect(record).not.toHaveBeenCalled();
  });

  it('lets only the creator invite', async () => {
    await expect(service.invite('garden', 'sam', 'mod')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sqls()).not.toContain(INSERT_MODERATOR_INVITE_SQL);
  });

  it('refuses a non-member, a moderator, the creator and a banned account', async () => {
    answers.set(IS_SUBSCRIBED_SQL, []);
    await expect(
      service.invite('garden', 'sam', 'creator'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    answers.set(IS_SUBSCRIBED_SQL, [{ subscribed: 1 }]);
    answers.set(IS_MODERATOR_SQL, [{ moderator: 1 }]);
    await expect(
      service.invite('garden', 'sam', 'creator'),
    ).rejects.toBeInstanceOf(ConflictException);

    answers.set(IS_MODERATOR_SQL, []);
    answers.set(INVITEE_SQL, [{ id: 'creator', username: 'owner' }]);
    await expect(
      service.invite('garden', 'owner', 'creator'),
    ).rejects.toBeInstanceOf(ConflictException);

    answers.set(INVITEE_SQL, [{ id: 'sam-id', username: 'sam' }]);
    banned = true;
    await expect(
      service.invite('garden', 'sam', 'creator'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sqls()).not.toContain(INSERT_MODERATOR_INVITE_SQL);
  });

  it('makes the invitee a moderator only on accepting, consuming the invitation', async () => {
    answers.set(LOCK_MODERATOR_INVITE_SQL, [{ invited_by: 'creator' }]);

    await service.accept('garden', 'sam-id');

    expect(sqls()).toContain(DELETE_MODERATOR_INVITE_SQL);
    expect(
      statements.find(({ sql }) => sql === INSERT_MODERATOR_SQL)?.values,
    ).toEqual(['c-1', 'sam-id', 'creator']);
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      actorId: 'sam-id',
      communityId: 'c-1',
      action: 'moderator_added',
      targetType: 'user',
      targetId: 'sam-id',
      metadata: { username: 'sam' },
    });
  });

  it('is 404 to accept without an invitation, and honours a ban since', async () => {
    await expect(service.accept('garden', 'sam-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    answers.set(LOCK_MODERATOR_INVITE_SQL, [{ invited_by: 'creator' }]);
    banned = true;
    await expect(service.accept('garden', 'sam-id')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sqls()).not.toContain(INSERT_MODERATOR_SQL);
  });

  it('declines without a username and revokes with one, each logged', async () => {
    await service.withdraw('garden', 'sam-id');
    expect(record).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: 'sam-id',
        action: 'moderator_invite_declined',
        targetId: 'sam-id',
      }),
    );

    await service.withdraw('garden', 'creator', 'sam');
    expect(record).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: 'creator',
        action: 'moderator_invite_revoked',
        targetId: 'sam-id',
      }),
    );

    await expect(
      service.withdraw('garden', 'mod', 'sam'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('logs nothing when no invitation was withdrawn', async () => {
    answers.set(DELETE_MODERATOR_INVITE_SQL, { affectedRows: 0 });
    await service.withdraw('garden', 'sam-id');
    expect(record).not.toHaveBeenCalled();
  });
});
