import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import type { NotificationEntry } from '../notifications/notification-metadata';
import type { NotificationsService } from '../notifications/notifications.service';
import { USER_ID_BY_USERNAME_SQL } from './user-activity.service';
import type { UserBlockPolicyService } from './user-block-policy.service';
import {
  FOLLOW_SQL,
  FOLLOW_STATUS_SQL,
  followCountSql,
  followListSql,
  LOCK_FOLLOW_PARTY_SQL,
  NOTIFY_NEW_FOLLOWERS_SQL,
  UNFOLLOW_SQL,
  UserFollowsService,
} from './user-follows.service';

interface Account {
  id: string;
  username: string;
  deleted_at: Date | null;
}

describe('UserFollowsService', () => {
  let accounts: Account[];
  let inserted: number;
  let preference: Array<{ notify_new_followers: number }>;
  let blocked: boolean;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let log: string[];
  let recorded: NotificationEntry[];
  let service: UserFollowsService;

  const execute = (sql: string, values: unknown[]) => {
    queries.push({ sql, values });
    if (sql === USER_ID_BY_USERNAME_SQL) {
      return Promise.resolve([
        accounts
          .filter((a) => a.username === values[0] && a.deleted_at === null)
          .map(({ id }) => ({ id })),
        [],
      ]);
    }
    if (sql === LOCK_FOLLOW_PARTY_SQL) {
      return Promise.resolve([accounts.filter((a) => a.id === values[0]), []]);
    }
    if (sql === FOLLOW_SQL) {
      return Promise.resolve([{ affectedRows: inserted }, []]);
    }
    if (sql === NOTIFY_NEW_FOLLOWERS_SQL) {
      return Promise.resolve([preference, []]);
    }
    if (sql === UNFOLLOW_SQL) {
      return Promise.resolve([{ affectedRows: 0 }, []]);
    }
    if (sql === FOLLOW_STATUS_SQL) {
      return Promise.resolve([[{ following: 1, followed_by: 0 }], []]);
    }
    if (sql.startsWith('SELECT u.username')) {
      return Promise.resolve([
        [
          {
            username: 'b_user',
            display_name: 'Bee',
            avatar_media_id: null,
            followed_at: new Date('2026-11-01T10:00:00.000Z'),
          },
        ],
        [],
      ]);
    }
    if (sql.startsWith('SELECT COUNT(*) AS total')) {
      return Promise.resolve([[{ total: '1' }], []]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  beforeEach(() => {
    accounts = [
      { id: 'u-a', username: 'a_user', deleted_at: null },
      { id: 'u-b', username: 'b_user', deleted_at: null },
      { id: 'u-gone', username: 'gone_user', deleted_at: new Date() },
    ];
    inserted = 1;
    preference = [];
    blocked = false;
    queries = [];
    log = [];
    recorded = [];
    const connection = {
      execute,
      beginTransaction: () => (log.push('begin'), Promise.resolve()),
      commit: () => (log.push('commit'), Promise.resolve()),
      rollback: () => (log.push('rollback'), Promise.resolve()),
      release: () => log.push('release'),
    };
    const pool = {
      execute,
      getConnection: () => Promise.resolve(connection),
    } as unknown as Pool;
    const blocks = {
      assertNotBlockedOrThrow: jest.fn(() =>
        blocked
          ? Promise.reject(new ForbiddenException({ reason: 'user_blocked' }))
          : Promise.resolve(),
      ),
    } as unknown as UserBlockPolicyService;
    const notifications = {
      record: (_connection: unknown, entry: NotificationEntry) => {
        recorded.push(entry);
        return Promise.resolve();
      },
    } as unknown as NotificationsService;
    service = new UserFollowsService(pool, blocks, notifications);
  });

  describe('follow', () => {
    it('locks both accounts in id order, inserts and notifies the followee', async () => {
      await service.follow('a_user', 'u-b');
      expect(queries.map(({ sql, values }) => [sql, values])).toEqual([
        [USER_ID_BY_USERNAME_SQL, ['a_user']],
        [LOCK_FOLLOW_PARTY_SQL, ['u-a']],
        [LOCK_FOLLOW_PARTY_SQL, ['u-b']],
        [FOLLOW_SQL, ['u-b', 'u-a']],
        [NOTIFY_NEW_FOLLOWERS_SQL, ['u-a']],
      ]);
      expect(recorded).toEqual([
        {
          recipientId: 'u-a',
          type: 'new_follower',
          actorId: 'u-b',
          subjectType: 'user',
          subjectId: 'u-b',
          communityId: null,
          metadata: { actor_username: 'b_user' },
        },
      ]);
      expect(log).toEqual(['begin', 'commit', 'release']);
    });

    it('is idempotent: a repeat follow does not notify again', async () => {
      inserted = 0;
      await service.follow('a_user', 'u-b');
      expect(queries.map(({ sql }) => sql)).not.toContain(
        NOTIFY_NEW_FOLLOWERS_SQL,
      );
      expect(recorded).toEqual([]);
      expect(log).toEqual(['begin', 'commit', 'release']);
    });

    it.each([
      [1, 1],
      [0, 0],
    ])(
      'notifies according to notify_new_followers = %s',
      async (value, count) => {
        preference = [{ notify_new_followers: value }];
        await service.follow('a_user', 'u-b');
        expect(recorded).toHaveLength(count);
      },
    );

    it('refuses yourself with 400, before any transaction', async () => {
      await expect(service.follow('a_user', 'u-a')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(log).toEqual([]);
    });

    it.each(['missing', 'gone_user'])(
      'answers 404 for %s',
      async (username) => {
        await expect(service.follow(username, 'u-a')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(log).toEqual([]);
      },
    );

    it('answers 404 when the follower was deleted meanwhile', async () => {
      accounts[1].deleted_at = new Date();
      await expect(service.follow('a_user', 'u-b')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(log).toEqual(['begin', 'rollback', 'release']);
    });

    it('answers 403 across a block, writing nothing', async () => {
      blocked = true;
      await expect(service.follow('a_user', 'u-b')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(queries.map(({ sql }) => sql)).not.toContain(FOLLOW_SQL);
      expect(recorded).toEqual([]);
      expect(log).toEqual(['begin', 'rollback', 'release']);
    });
  });

  describe('unfollow', () => {
    it('deletes by bound ids and is idempotent', async () => {
      await expect(service.unfollow('a_user', 'u-b')).resolves.toBeUndefined();
      expect(queries.at(-1)).toEqual({
        sql: UNFOLLOW_SQL,
        values: ['u-b', 'u-a'],
      });
    });

    it('answers 404 for an unknown account', async () => {
      await expect(service.unfollow('missing', 'u-b')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('list', () => {
    it.each(['followers', 'following'] as const)(
      'pages %s without a viewer filter when signed out',
      async (side) => {
        await expect(
          service.list(side, 'a_user', undefined, { page: 2, limit: 10 }),
        ).resolves.toEqual({
          items: [
            {
              username: 'b_user',
              display_name: 'Bee',
              avatar_url: null,
              followed_at: '2026-11-01T10:00:00.000Z',
            },
          ],
          page: 2,
          limit: 10,
          total: 1,
        });
        expect(queries.slice(1)).toEqual([
          { sql: followListSql(side, false), values: ['u-a', 10, 10] },
          { sql: followCountSql(side, false), values: ['u-a'] },
        ]);
      },
    );

    it('leaves out accounts blocked either way by a signed-in viewer', async () => {
      await service.list('followers', 'a_user', 'u-b', {});
      expect(queries.slice(1)).toEqual([
        {
          sql: followListSql('followers', true),
          values: ['u-a', 'u-b', 'u-b', 20, 0],
        },
        {
          sql: followCountSql('followers', true),
          values: ['u-a', 'u-b', 'u-b'],
        },
      ]);
    });

    it('joins the right side and never lists a deleted account', () => {
      expect(followListSql('followers', false)).toMatch(
        /u\.id = f\.follower_id\s+WHERE f\.followee_id = \?\s+AND u\.deleted_at IS NULL/,
      );
      expect(followListSql('following', false)).toMatch(
        /u\.id = f\.followee_id\s+WHERE f\.follower_id = \?\s+AND u\.deleted_at IS NULL/,
      );
      expect(followListSql('following', true)).toContain('user_blocks');
      expect(followListSql('following', false)).not.toContain('user_blocks');
    });
  });

  it('reports both directions for the caller', async () => {
    await expect(service.status('a_user', 'u-b')).resolves.toEqual({
      following: true,
      followed_by: false,
    });
    expect(queries.at(-1)).toEqual({
      sql: FOLLOW_STATUS_SQL,
      values: ['u-b', 'u-a', 'u-a', 'u-b'],
    });
  });
});
