import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import { ACTIVE_COMMUNITY_BAN_PREDICATE } from '../common/active-community-ban';
import { CommunityBansService } from './community-bans.service';
import type { CommunityModerationLogService } from './community-moderation-log.service';
import {
  CreateCommunityBanDto,
  ListCommunityBansDto,
} from './dto/community-ban.dto';

type Call = { sql: string; values: unknown[] };

const CREATOR = 'creator-id';
const MODERATOR = 'moderator-id';
const COMMUNITY = 'community-id';

describe('CommunityBansService', () => {
  let calls: Call[];
  let users: Record<string, string>;
  let moderators: Set<string>;
  let canModerate: boolean;
  let communityExists: boolean;
  let activeBan: boolean;
  let anyBan: boolean;
  let liftAffected: number;
  let subscriptionsDeleted: number;
  let banRow: Record<string, unknown>;
  let logged: Array<{ connection: unknown; entry: Record<string, unknown> }>;
  let failLog: boolean;
  let tx: {
    begins: number;
    commits: number;
    rollbacks: number;
    releases: number;
  };
  let connection: Record<string, unknown>;
  let service: CommunityBansService;

  const respond = (sql: string, values: unknown[]): [unknown, unknown] => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT c.id, c.creator_id')) {
      return [
        communityExists
          ? [
              {
                id: COMMUNITY,
                creator_id: CREATOR,
                can_moderate: canModerate ? 1 : 0,
              },
            ]
          : [],
        [],
      ];
    }
    if (sql.startsWith('SELECT id, username FROM users')) {
      const id = users[values[0] as string];
      return [id ? [{ id, username: values[0] }] : [], []];
    }
    if (sql.startsWith('SELECT user_id FROM community_moderators')) {
      return [
        moderators.has(values[1] as string) ? [{ user_id: values[1] }] : [],
        [],
      ];
    }
    if (sql.includes('FROM community_bans') && sql.includes('FOR UPDATE')) {
      return [activeBan ? [{ id: 'existing-ban' }] : [], []];
    }
    if (
      sql.startsWith('SELECT id FROM community_bans WHERE community_id = ?')
    ) {
      return [anyBan ? [{ id: 'old-ban' }] : [], []];
    }
    if (sql.startsWith('SELECT community_bans.id')) {
      return [[banRow], []];
    }
    if (sql.startsWith('SELECT COUNT(*) AS total')) {
      return [[{ total: 1 }], []];
    }
    if (sql.startsWith('UPDATE community_bans')) {
      return [{ affectedRows: liftAffected }, []];
    }
    if (sql.startsWith('DELETE FROM community_subscriptions')) {
      return [{ affectedRows: subscriptionsDeleted }, []];
    }
    return [{ affectedRows: 1 }, []];
  };

  beforeEach(() => {
    calls = [];
    users = {
      creator: CREATOR,
      a_moderator: MODERATOR,
      other_moderator: 'other-moderator-id',
      member: 'member-id',
      platform_admin: 'admin-id',
    };
    moderators = new Set([MODERATOR, 'other-moderator-id']);
    canModerate = true;
    communityExists = true;
    activeBan = false;
    anyBan = true;
    liftAffected = 1;
    subscriptionsDeleted = 1;
    banRow = {
      id: 'ban-id',
      username: 'member',
      reason: 'Spam',
      created_by_username: 'a_moderator',
      created_at: '2026-10-27T09:00:00Z',
      expires_at: null,
      lifted_at: null,
      lifted_by_username: null,
      lift_reason: null,
      active: 1,
    };
    logged = [];
    failLog = false;
    tx = { begins: 0, commits: 0, rollbacks: 0, releases: 0 };
    connection = {
      beginTransaction: () => {
        tx.begins += 1;
        return Promise.resolve();
      },
      commit: () => {
        tx.commits += 1;
        return Promise.resolve();
      },
      rollback: () => {
        tx.rollbacks += 1;
        return Promise.resolve();
      },
      release: () => {
        tx.releases += 1;
      },
      execute: (sql: string, values: unknown[]) =>
        Promise.resolve(respond(sql, values)),
    };
    service = new CommunityBansService(
      {
        execute: (sql: string, values: unknown[]) =>
          Promise.resolve(respond(sql, values)),
        getConnection: () => Promise.resolve(connection),
      } as unknown as Pool,
      {
        record: (onConnection: unknown, entry: Record<string, unknown>) => {
          logged.push({ connection: onConnection, entry });
          return failLog
            ? Promise.reject(new Error('Log insert failed'))
            : Promise.resolve();
        },
      } as unknown as CommunityModerationLogService,
    );
  });

  const ban = (
    overrides: Partial<CreateCommunityBanDto> = {},
    actor = MODERATOR,
  ) =>
    service.ban(
      'a-community',
      { username: 'member', reason: 'Spam', ...overrides },
      actor,
    );
  const sqlOf = (prefix: string) =>
    calls.filter(({ sql }) =>
      sql.replace(/\s+/g, ' ').trim().startsWith(prefix),
    );
  const insert = () => sqlOf('INSERT INTO community_bans')[0];
  const refusedCleanly = () => {
    expect(insert()).toBeUndefined();
    expect(sqlOf('DELETE')).toHaveLength(0);
    expect(logged).toHaveLength(0);
  };

  describe('ban', () => {
    it('inserts one permanent ban with created_by from the caller', async () => {
      const result = await ban();
      expect(insert().sql).toMatch(/VALUES \(\?, \?, \?, \?, \?, NULL\)/);
      expect(insert().values).toEqual([
        expect.any(String),
        COMMUNITY,
        'member-id',
        'Spam',
        MODERATOR,
      ]);
      expect(result).toMatchObject({
        id: 'ban-id',
        active: true,
        expires_at: null,
      });
      expect(tx).toEqual({ begins: 1, commits: 1, rollbacks: 0, releases: 1 });
    });

    it('derives a temporary ban’s expiry from the database clock', async () => {
      const now = jest.spyOn(Date, 'now');
      await ban({ duration_hours: 72 });
      expect(insert().sql).toContain(
        'DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR)',
      );
      expect(insert().values.at(-1)).toBe(72);
      expect(now).not.toHaveBeenCalled();
      now.mockRestore();
    });

    it('locks the account, then re-checks for an active ban with the shared predicate', async () => {
      await ban();
      const lock = sqlOf('SELECT id, username FROM users')[0];
      expect(lock.sql).toContain('FOR UPDATE');
      const recheck = calls.find(
        ({ sql }) =>
          sql.includes('FROM community_bans') && sql.includes('FOR UPDATE'),
      )!;
      expect(recheck.sql).toContain(ACTIVE_COMMUNITY_BAN_PREDICATE);
      expect(recheck.values).toEqual([COMMUNITY, 'member-id']);
      expect(calls.indexOf(lock)).toBeLessThan(calls.indexOf(recheck));
      expect(calls.indexOf(recheck)).toBeLessThan(calls.indexOf(insert()));
    });

    it('ends the membership in this community only, and keeps rule acceptances', async () => {
      await ban();
      expect(sqlOf('DELETE FROM community_subscriptions')).toEqual([
        {
          sql: 'DELETE FROM community_subscriptions WHERE community_id = ? AND user_id = ?',
          values: [COMMUNITY, 'member-id'],
        },
      ]);
      for (const { sql } of calls) {
        expect(sql).not.toContain('community_rule_acceptances');
      }
    });

    it('records one member_banned entry on the transaction connection', async () => {
      banRow.expires_at = '2026-10-30T09:00:00Z';
      await ban({ duration_hours: 72 });
      expect(logged).toEqual([
        {
          connection,
          entry: {
            actorId: MODERATOR,
            communityId: COMMUNITY,
            action: 'member_banned',
            targetType: 'user',
            targetId: 'member-id',
            metadata: {
              username: 'member',
              reason: 'Spam',
              expires_at: '2026-10-30T09:00:00.000Z',
            },
          },
        },
      ]);
    });

    it('lets the creator ban a moderator, dropping the role in the same transaction', async () => {
      await ban({ username: 'a_moderator' }, CREATOR);
      expect(sqlOf('DELETE FROM community_moderators')).toEqual([
        {
          sql: 'DELETE FROM community_moderators WHERE community_id = ? AND user_id = ?',
          values: [COMMUNITY, MODERATOR],
        },
      ]);
      expect(logged).toHaveLength(1);
    });

    it('does not touch the moderator table for an ordinary member', async () => {
      await ban();
      expect(sqlOf('DELETE FROM community_moderators')).toHaveLength(0);
    });

    // The scopes are independent: platform role is never consulted.
    it('bans a platform administrator like anyone else', async () => {
      await ban({ username: 'platform_admin' });
      expect(insert().values[2]).toBe('admin-id');
      for (const { sql } of calls) {
        expect(sql).not.toMatch(/\brole\b/);
      }
    });

    // The distinction the feature exists to preserve.
    it('never reads or writes a platform restriction', async () => {
      await ban();
      await service.lift('a-community', 'member', {}, MODERATOR);
      await service.removeMember('a-community', 'member', MODERATOR);
      for (const { sql } of calls) {
        expect(sql).not.toContain('user_restrictions');
      }
      // Every write is keyed to this community.
      for (const { sql, values } of calls) {
        if (/^(INSERT|UPDATE|DELETE)/.test(sql)) {
          expect(values).toContain(COMMUNITY);
        }
      }
    });

    describe('refusals', () => {
      it('answers an unknown community with 404, before authorization', async () => {
        communityExists = false;
        canModerate = false;
        await expect(ban()).rejects.toBeInstanceOf(NotFoundException);
        expect(tx.begins).toBe(0);
      });

      it('answers a caller who does not moderate with 403', async () => {
        canModerate = false;
        await expect(ban()).rejects.toBeInstanceOf(ForbiddenException);
        expect(tx.begins).toBe(0);
        refusedCleanly();
      });

      it.each([
        [
          'an unknown username',
          { username: 'nobody' },
          MODERATOR,
          NotFoundException,
        ],
        [
          'banning yourself',
          { username: 'a_moderator' },
          MODERATOR,
          BadRequestException,
        ],
        [
          'banning the creator',
          { username: 'creator' },
          MODERATOR,
          ForbiddenException,
        ],
        [
          'a moderator banning another moderator',
          { username: 'other_moderator' },
          MODERATOR,
          ForbiddenException,
        ],
      ] as const)('refuses %s', async (_name, overrides, actor, error) => {
        await expect(ban(overrides, actor)).rejects.toBeInstanceOf(error);
        refusedCleanly();
        expect(tx).toMatchObject({ commits: 0, rollbacks: 1, releases: 1 });
      });

      it('refuses the creator banning themselves with 400', async () => {
        await expect(
          ban({ username: 'creator' }, CREATOR),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('refuses stacking a second active ban with 409', async () => {
        activeBan = true;
        await expect(ban()).rejects.toBeInstanceOf(ConflictException);
        refusedCleanly();
        expect(tx).toMatchObject({ rollbacks: 1, releases: 1 });
      });
    });

    it('rolls everything back when the log entry cannot be written', async () => {
      failLog = true;
      await expect(ban()).rejects.toThrow('Log insert failed');
      expect(insert()).toBeDefined();
      expect(tx).toMatchObject({ commits: 0, rollbacks: 1, releases: 1 });
    });

    // Two bans of one person: the account lock makes the second wait, and its
    // re-check then sees the first.
    it('yields one ban and one 409 for two concurrent bans', async () => {
      const stored: string[] = [];
      let unlock: () => void = () => undefined;
      let locked: Promise<void> | null = null;
      const concurrent = new CommunityBansService(
        {
          execute: (sql: string, values: unknown[]) =>
            Promise.resolve(respond(sql, values)),
          getConnection: () => {
            let holdsLock = false;
            return Promise.resolve({
              beginTransaction: () => Promise.resolve(),
              commit: () => {
                if (holdsLock) unlock();
                return Promise.resolve();
              },
              rollback: () => {
                if (holdsLock) unlock();
                return Promise.resolve();
              },
              release: () => undefined,
              execute: async (sql: string, values: unknown[]) => {
                if (sql.startsWith('SELECT id, username FROM users')) {
                  while (locked) await locked;
                  locked = new Promise<void>((resolve) => {
                    unlock = () => {
                      locked = null;
                      resolve();
                    };
                  });
                  holdsLock = true;
                }
                if (
                  sql.includes('FROM community_bans') &&
                  sql.includes('FOR UPDATE')
                ) {
                  return [stored.map((id) => ({ id })), []];
                }
                if (sql.startsWith('INSERT INTO community_bans')) {
                  // Yield, so the competitor runs while this one holds the lock.
                  await new Promise((resolve) => setTimeout(resolve, 5));
                  stored.push(values[0] as string);
                  return [{ affectedRows: 1 }, []];
                }
                return respond(sql, values);
              },
            });
          },
        } as unknown as Pool,
        {
          record: () => Promise.resolve(),
        } as unknown as CommunityModerationLogService,
      );

      const results = await Promise.allSettled([
        concurrent.ban(
          'a-community',
          { username: 'member', reason: 'A' },
          MODERATOR,
        ),
        concurrent.ban(
          'a-community',
          { username: 'member', reason: 'B' },
          CREATOR,
        ),
      ]);
      expect(
        results.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(stored).toHaveLength(1);
    });
  });

  describe('lift', () => {
    it('closes the open bans with a conditional update and logs once', async () => {
      await service.lift(
        'a-community',
        'member',
        { lift_reason: 'Appeal accepted' },
        MODERATOR,
      );
      const [update] = sqlOf('UPDATE community_bans');
      expect(update.sql.replace(/\s+/g, ' ')).toContain(
        'SET lifted_at = UTC_TIMESTAMP(), lifted_by = ?, lift_reason = ? WHERE community_id = ? AND user_id = ? AND lifted_at IS NULL',
      );
      expect(update.values).toEqual([
        MODERATOR,
        'Appeal accepted',
        COMMUNITY,
        'member-id',
      ]);
      expect(logged.map(({ entry }) => entry.action)).toEqual([
        'member_unbanned',
      ]);
      expect(logged[0].entry.metadata).toEqual({ username: 'member' });
    });

    it('stores a null lift_reason when none is given', async () => {
      await service.lift('a-community', 'member', {}, MODERATOR);
      expect(sqlOf('UPDATE community_bans')[0].values[1]).toBeNull();
    });

    it('never recreates the membership', async () => {
      await service.lift('a-community', 'member', {}, MODERATOR);
      for (const { sql } of calls) {
        expect(sql).not.toContain('community_subscriptions');
      }
    });

    it('answers 404 for a user never banned here, and 409 once lifted', async () => {
      liftAffected = 0;
      anyBan = false;
      await expect(
        service.lift('a-community', 'member', {}, MODERATOR),
      ).rejects.toThrow(
        new NotFoundException('User was never banned from this community'),
      );
      anyBan = true;
      await expect(
        service.lift('a-community', 'member', {}, MODERATOR),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(logged).toHaveLength(0);
      expect(tx).toMatchObject({ commits: 0, rollbacks: 2, releases: 2 });
    });

    it('answers 404 for an unknown user and 403 for a non-moderator', async () => {
      await expect(
        service.lift('a-community', 'nobody', {}, MODERATOR),
      ).rejects.toBeInstanceOf(NotFoundException);
      canModerate = false;
      await expect(
        service.lift('a-community', 'member', {}, 'member-id'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rolls the lift back when the log entry cannot be written', async () => {
      failLog = true;
      await expect(
        service.lift('a-community', 'member', {}, MODERATOR),
      ).rejects.toThrow('Log insert failed');
      expect(tx).toMatchObject({ commits: 0, rollbacks: 1, releases: 1 });
    });
  });

  describe('removeMember', () => {
    it('deletes only the subscription, creates no ban, and logs member_removed', async () => {
      await service.removeMember('a-community', 'member', MODERATOR);
      expect(sqlOf('DELETE')).toEqual([
        {
          sql: 'DELETE FROM community_subscriptions WHERE community_id = ? AND user_id = ?',
          values: [COMMUNITY, 'member-id'],
        },
      ]);
      expect(sqlOf('INSERT')).toHaveLength(0);
      for (const { sql } of calls) {
        expect(sql).not.toContain('community_bans');
      }
      expect(logged.map(({ entry }) => entry.action)).toEqual([
        'member_removed',
      ]);
    });

    it('is idempotent for a non-member, and logs nothing then', async () => {
      subscriptionsDeleted = 0;
      await service.removeMember('a-community', 'member', MODERATOR);
      expect(logged).toHaveLength(0);
      expect(tx).toMatchObject({ commits: 1, releases: 1 });
    });

    it.each([
      ['yourself', 'a_moderator', MODERATOR, BadRequestException],
      ['the creator', 'creator', MODERATOR, ForbiddenException],
      [
        'a moderator, as a moderator',
        'other_moderator',
        MODERATOR,
        ForbiddenException,
      ],
      [
        'a moderator, as the creator',
        'a_moderator',
        CREATOR,
        ConflictException,
      ],
      ['an unknown user', 'nobody', MODERATOR, NotFoundException],
    ] as const)(
      'refuses removing %s',
      async (_name, username, actor, error) => {
        await expect(
          service.removeMember('a-community', username, actor),
        ).rejects.toBeInstanceOf(error);
        expect(sqlOf('DELETE')).toHaveLength(0);
        expect(tx).toMatchObject({ rollbacks: 1, releases: 1 });
      },
    );

    it('rolls the removal back when the log entry cannot be written', async () => {
      failLog = true;
      await expect(
        service.removeMember('a-community', 'member', MODERATOR),
      ).rejects.toThrow('Log insert failed');
      expect(tx).toMatchObject({ commits: 0, rollbacks: 1, releases: 1 });
    });
  });

  describe('list', () => {
    const list = (active?: 'any' | 'active' | 'lifted') =>
      service.list(
        'a-community',
        MODERATOR,
        Object.assign(new ListCommunityBansDto(), active ? { active } : {}),
      );

    it.each([
      ['active', ` AND (${ACTIVE_COMMUNITY_BAN_PREDICATE})`],
      ['lifted', ` AND NOT (${ACTIVE_COMMUNITY_BAN_PREDICATE})`],
    ] as const)(
      'filters %s bans by the shared predicate, in page and count',
      async (state, clause) => {
        await list(state);
        const [page] = sqlOf('SELECT community_bans.id');
        const [count] = sqlOf('SELECT COUNT(*)');
        expect(page.sql).toContain(
          `WHERE community_bans.community_id = ?${clause}`,
        );
        expect(count.sql).toContain(
          `WHERE community_bans.community_id = ?${clause}`,
        );
      },
    );

    it('defaults to active, and applies no state filter for any', async () => {
      await list();
      expect(sqlOf('SELECT community_bans.id')[0].sql).toContain(
        `AND (${ACTIVE_COMMUNITY_BAN_PREDICATE})`,
      );
      calls = [];
      await list('any');
      expect(sqlOf('SELECT community_bans.id')[0].sql).not.toContain(
        ACTIVE_COMMUNITY_BAN_PREDICATE + ')\n',
      );
      expect(sqlOf('SELECT COUNT(*)')[0].sql).not.toContain('lifted_at');
    });

    it('orders newest first with an id tiebreaker and pages', async () => {
      await service.list(
        'a-community',
        MODERATOR,
        Object.assign(new ListCommunityBansDto(), { page: 3, limit: 10 }),
      );
      const [page] = sqlOf('SELECT community_bans.id');
      expect(page.sql).toMatch(
        /ORDER BY community_bans\.created_at DESC, community_bans\.id DESC\s+LIMIT \? OFFSET \?/,
      );
      expect(page.values).toEqual([COMMUNITY, 10, 20]);
    });

    it('renders deleted accounts as null usernames, and active from the predicate', async () => {
      banRow = {
        ...banRow,
        username: null,
        created_by_username: null,
        lifted_by_username: null,
        lifted_at: '2026-10-28T09:00:00Z',
        lift_reason: 'Done',
        active: 0,
      };
      const { items } = await list('any');
      expect(items[0]).toEqual({
        id: 'ban-id',
        username: null,
        reason: 'Spam',
        created_by_username: null,
        created_at: '2026-10-27T09:00:00.000Z',
        expires_at: null,
        lifted_at: '2026-10-28T09:00:00.000Z',
        lifted_by_username: null,
        lift_reason: 'Done',
        active: false,
      });
      const select = sqlOf('SELECT community_bans.id')[0].sql;
      for (const alias of ['target', 'creator', 'lifter']) {
        expect(select).toContain(
          `CASE WHEN ${alias}.deleted_at IS NULL THEN ${alias}.username END`,
        );
      }
      expect(select).toContain(`(${ACTIVE_COMMUNITY_BAN_PREDICATE}) AS active`);
    });

    it('answers 404 for an unknown community and 403 for a member', async () => {
      communityExists = false;
      await expect(list()).rejects.toBeInstanceOf(NotFoundException);
      communityExists = true;
      canModerate = false;
      await expect(list()).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
