import { answerCommunityAccess } from './fakes/community-access';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import { CommunityBanPolicyService } from '../src/communities/community-ban-policy.service';

interface Ban {
  id: string;
  community_id: string;
  user_id: string;
  reason: string;
  created_by: string | null;
  expires_at: number | null;
  lifted_at: number | null;
  lifted_by: string | null;
  lift_reason: string | null;
  created_at: number;
}

const NOW = Date.UTC(2026, 9, 27, 12);

interface BanItem {
  id: string;
  username: string | null;
  created_by_username: string | null;
  expires_at: string | null;
  active: boolean;
}
interface BanList {
  items: BanItem[];
  total: number;
}
const banOf = (response: request.Response) => response.body as BanItem;
const listOf = (response: request.Response) => response.body as BanList;
const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();

describe('Community bans (e2e)', () => {
  let app: INestApplication<App>;
  let users: Map<string, { username: string; email: string; deleted: boolean }>;
  let moderators: Set<string>;
  let subscriptions: Set<string>;
  let acceptances: string[];
  let bans: Ban[];
  let log: Array<{
    community_id: unknown;
    action: unknown;
    target_id: unknown;
  }>;
  let restrictions: unknown[];
  let failLog: boolean;
  let clock: number;
  let tx: { commits: number; rollbacks: number; releases: number };

  const communities = [
    { id: 'c-a', name: 'a-community', creator_id: 'u-creator' },
    { id: 'c-b', name: 'b-community', creator_id: 'u-other-creator' },
  ];
  const key = (community: string, user: string) => `${community}:${user}`;
  const active = (ban: Ban) =>
    ban.lifted_at === null && (ban.expires_at === null || ban.expires_at > NOW);

  beforeEach(async () => {
    users = new Map(
      [
        ['u-creator', 'creator'],
        ['u-mod', 'a_moderator'],
        ['u-mod2', 'other_moderator'],
        ['u-member', 'member'],
        ['u-admin', 'platform_admin'],
        ['u-outsider', 'outsider'],
        ['u-other-creator', 'other_creator'],
      ].map(([id, username]) => [
        id,
        { username, email: `${username}@example.com`, deleted: false },
      ]),
    );
    moderators = new Set([key('c-a', 'u-mod'), key('c-a', 'u-mod2')]);
    subscriptions = new Set([
      key('c-a', 'u-member'),
      key('c-a', 'u-mod'),
      key('c-a', 'u-mod2'),
      key('c-a', 'u-admin'),
      key('c-b', 'u-member'),
    ]);
    acceptances = [key('c-a', 'u-member'), key('c-b', 'u-member')];
    bans = [];
    log = [];
    restrictions = [];
    failLog = false;
    clock = NOW - 3_600_000;
    tx = { commits: 0, rollbacks: 0, releases: 0 };
    // Undone on rollback, as the transaction would be.
    let snapshot: string | null = null;
    const save = () =>
      JSON.stringify({
        bans,
        subscriptions: [...subscriptions],
        moderators: [...moderators],
        log,
      });
    const restore = (state: string) => {
      const parsed = JSON.parse(state) as {
        bans: Ban[];
        subscriptions: string[];
        moderators: string[];
        log: typeof log;
      };
      bans = parsed.bans;
      subscriptions = new Set(parsed.subscriptions);
      moderators = new Set(parsed.moderators);
      log = parsed.log;
    };

    const username = (id: string | null) => {
      const user = id === null ? undefined : users.get(id);
      return user && !user.deleted ? user.username : null;
    };
    const banRow = (ban: Ban) => ({
      id: ban.id,
      username: username(ban.user_id),
      reason: ban.reason,
      created_by_username: username(ban.created_by),
      created_at: iso(ban.created_at),
      expires_at: iso(ban.expires_at),
      lifted_at: iso(ban.lifted_at),
      lifted_by_username: username(ban.lifted_by),
      lift_reason: ban.lift_reason,
      active: active(ban) ? 1 : 0,
    });
    const userBy = (name: unknown) =>
      [...users].find(([, user]) => user.username === name && !user.deleted);

    const execute = (
      sql: string,
      values: unknown[] = [],
    ): unknown[] | object => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (/user_restrictions/.test(flat)) {
        restrictions.push(flat);
        throw new Error('A community ban must never touch user_restrictions');
      }
      if (flat.startsWith('SELECT c.id, c.creator_id')) {
        const [actor, , name] = values as string[];
        const community = communities.find((row) => row.name === name);
        return community
          ? [
              {
                id: community.id,
                creator_id: community.creator_id,
                can_moderate:
                  community.creator_id === actor ||
                  moderators.has(key(community.id, actor))
                    ? 1
                    : 0,
              },
            ]
          : [];
      }
      if (
        flat.startsWith('SELECT id, username FROM users WHERE username = ?')
      ) {
        const user = userBy(values[0]);
        return user ? [{ id: user[0], username: user[1].username }] : [];
      }
      if (flat.startsWith('SELECT user_id FROM community_moderators')) {
        const [community, user] = values as string[];
        return moderators.has(key(community, user)) ? [{ user_id: user }] : [];
      }
      if (
        flat.startsWith(
          'SELECT id FROM community_bans WHERE community_id = ? AND user_id = ? AND lifted_at IS NULL',
        )
      ) {
        const [community, user] = values;
        return bans
          .filter(
            (ban) =>
              ban.community_id === community &&
              ban.user_id === user &&
              active(ban),
          )
          .map(({ id }) => ({ id }));
      }
      if (
        flat.startsWith(
          'SELECT id FROM community_bans WHERE community_id = ? AND user_id = ? LIMIT 1',
        )
      ) {
        const [community, user] = values;
        return bans
          .filter(
            (ban) => ban.community_id === community && ban.user_id === user,
          )
          .map(({ id }) => ({ id }));
      }
      if (flat.startsWith('INSERT INTO community_bans')) {
        const [id, community, user, reason, by, hours] = values as [
          string,
          string,
          string,
          string,
          string,
          number | undefined,
        ];
        clock += 60_000;
        bans.push({
          id,
          community_id: community,
          user_id: user,
          reason,
          created_by: by,
          expires_at: flat.includes('DATE_ADD')
            ? NOW + Number(hours) * 3_600_000
            : null,
          lifted_at: null,
          lifted_by: null,
          lift_reason: null,
          created_at: clock,
        });
        return { affectedRows: 1 };
      }
      if (flat.startsWith('DELETE FROM community_subscriptions')) {
        const [community, user] = values as string[];
        return {
          affectedRows: subscriptions.delete(key(community, user)) ? 1 : 0,
        };
      }
      if (flat.startsWith('DELETE FROM community_moderators')) {
        const [community, user] = values as string[];
        return {
          affectedRows: moderators.delete(key(community, user)) ? 1 : 0,
        };
      }
      if (flat.startsWith('UPDATE community_bans SET lifted_at')) {
        const [by, reason, community, user] = values;
        let affectedRows = 0;
        for (const ban of bans) {
          if (
            ban.community_id === community &&
            ban.user_id === user &&
            ban.lifted_at === null
          ) {
            Object.assign(ban, {
              lifted_at: NOW,
              lifted_by: by,
              lift_reason: reason,
            });
            affectedRows += 1;
          }
        }
        return { affectedRows };
      }
      if (flat.startsWith('SELECT community_bans.id')) {
        if (flat.includes('WHERE community_bans.id = ?')) {
          return bans.filter((ban) => ban.id === values[0]).map(banRow);
        }
        const [community, limit, offset] = values as [string, number, number];
        return filtered(flat, community)
          .sort(
            (a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id),
          )
          .slice(offset, offset + limit)
          .map(banRow);
      }
      if (flat.startsWith('SELECT COUNT(*) AS total FROM community_bans')) {
        return [{ total: filtered(flat, values[0] as string).length }];
      }
      if (flat === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
        const user = users.get(values[0] as string);
        return user ? [{ username: user.username }] : [];
      }
      if (flat.startsWith('INSERT INTO community_moderation_actions')) {
        if (failLog) {
          throw new Error('Log insert failed');
        }
        log.push({
          community_id: values[1],
          action: values[4],
          target_id: values[6],
        });
        return { affectedRows: 1 };
      }
      // POST /communities/:name/subscribe, with no rules published.
      if (flat.startsWith('SELECT id FROM communities WHERE name = ?')) {
        const community = communities.find((row) => row.name === values[0]);
        return community ? [{ id: community.id }] : [];
      }
      if (flat.includes('FROM community_rule_documents')) {
        return [];
      }
      // Subscribing reads the community's visibility (migration 038).
      const access = answerCommunityAccess(
        sql,
        values,
        communities,
        (community, user) =>
          subscriptions.has(key(community, user)) ||
          moderators.has(key(community, user)),
      );
      if (access) {
        return access[0];
      }
      if (flat.startsWith('INSERT INTO community_subscriptions')) {
        const [user, community] = values as string[];
        subscriptions.add(key(community, user));
        return { affectedRows: 1 };
      }
      // The enforcement lookup (ACTIVE_COMMUNITY_BAN_STATE_SQL): the active
      // ban of (community, user), with the community's name.
      if (flat.startsWith('SELECT communities.name AS community_name')) {
        const [community, user] = values as string[];
        const ban = bans.find(
          (row) =>
            row.community_id === community &&
            row.user_id === user &&
            active(row),
        );
        return ban
          ? [
              {
                community_name: communities.find((c) => c.id === community)!
                  .name,
                expires_at: iso(ban.expires_at),
              },
            ]
          : [];
      }
      // The global notification default on joining (migration 037).
      if (flat.startsWith('INSERT INTO community_notification_preferences')) {
        return [{ affectedRows: 0 }, []];
      }
      throw new Error(`Unexpected SQL: ${flat}`);
    };
    const filtered = (flat: string, community: string) =>
      bans.filter(
        (ban) =>
          ban.community_id === community &&
          (flat.includes('AND NOT (lifted_at')
            ? !active(ban)
            : flat.includes('AND (lifted_at')
              ? active(ban)
              : true),
      );
    const run = (sql: string, values?: unknown[]) => {
      try {
        return Promise.resolve([execute(sql, values), []]);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    };

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute: run,
        getConnection: () =>
          Promise.resolve({
            beginTransaction: () => {
              snapshot = save();
              return Promise.resolve();
            },
            commit: () => {
              tx.commits += 1;
              snapshot = null;
              return Promise.resolve();
            },
            rollback: () => {
              tx.rollbacks += 1;
              if (snapshot) restore(snapshot);
              return Promise.resolve();
            },
            release: () => {
              tx.releases += 1;
            },
            execute: run,
          }),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) => {
          const id = `u-${token.replace(/-token$/, '')}`;
          return Promise.resolve(
            users.has(id)
              ? { kind: 'valid', emailVerified: true, userId: id }
              : { kind: 'invalid' },
          );
        },
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    // The distinction this feature exists to preserve.
    expect(restrictions).toEqual([]);
    await app.close();
  });

  const as = (who: string | null) => {
    const auth = (test: request.Test) =>
      who === null ? test : test.set('Authorization', `Bearer ${who}-token`);
    const server = () => request(app.getHttpServer());
    return {
      list: (query = '', community = 'a-community') =>
        auth(server().get(`/communities/${community}/bans${query}`)),
      ban: (body: object, community = 'a-community') =>
        auth(server().post(`/communities/${community}/bans`)).send(body),
      lift: (username: string, body: object = {}, community = 'a-community') =>
        auth(
          server().post(`/communities/${community}/bans/${username}/lift`),
        ).send(body),
      remove: (username: string, community = 'a-community') =>
        auth(
          server().post(`/communities/${community}/members/${username}/remove`),
        ),
      subscribe: (community = 'a-community') =>
        auth(server().post(`/communities/${community}/subscribe`)),
    };
  };
  const creator = as('creator');
  const moderator = as('mod');
  const BAN = { username: 'member', reason: 'Repeated spam' };

  describe('POST /communities/:name/bans', () => {
    it.each([
      ['the creator', creator],
      ['a moderator', moderator],
    ])('lets %s ban, ending the membership here only', async (_name, actor) => {
      const response = await actor.ban(BAN).expect(201);
      expect(response.body).toMatchObject({
        username: 'member',
        reason: 'Repeated spam',
        expires_at: null,
        lifted_at: null,
        active: true,
      });
      expect(bans).toHaveLength(1);
      expect(subscriptions.has(key('c-a', 'u-member'))).toBe(false);
      // Another community is untouched, and rule acceptances are kept.
      expect(subscriptions.has(key('c-b', 'u-member'))).toBe(true);
      expect(acceptances).toEqual([
        key('c-a', 'u-member'),
        key('c-b', 'u-member'),
      ]);
      expect(log).toEqual([
        { community_id: 'c-a', action: 'member_banned', target_id: 'u-member' },
      ]);
    });

    it('sets a temporary ban’s expiry from the duration', async () => {
      const response = await moderator
        .ban({ ...BAN, duration_hours: 48 })
        .expect(201);
      expect(banOf(response).expires_at).toBe(iso(NOW + 48 * 3_600_000));
    });

    it('bans a platform administrator from the community', async () => {
      await moderator.ban({ ...BAN, username: 'platform_admin' }).expect(201);
      expect(bans[0].user_id).toBe('u-admin');
    });

    it('lets the creator ban a moderator, dropping the role', async () => {
      await creator.ban({ ...BAN, username: 'a_moderator' }).expect(201);
      expect(moderators.has(key('c-a', 'u-mod'))).toBe(false);
    });

    it.each([
      ['no token', as(null), BAN, 401],
      ['a caller who does not moderate', as('outsider'), BAN, 403],
      ['a moderator of another community', as('other-creator'), BAN, 403],
      ['banning yourself', moderator, { ...BAN, username: 'a_moderator' }, 400],
      ['banning the creator', moderator, { ...BAN, username: 'creator' }, 403],
      [
        'a moderator banning a moderator',
        moderator,
        { ...BAN, username: 'other_moderator' },
        403,
      ],
      ['an unknown username', moderator, { ...BAN, username: 'nobody' }, 404],
      ['a missing reason', moderator, { username: 'member' }, 400],
      ['a blank reason', moderator, { ...BAN, reason: '   ' }, 400],
      ['duration_hours 0', moderator, { ...BAN, duration_hours: 0 }, 400],
      ['duration_hours -1', moderator, { ...BAN, duration_hours: -1 }, 400],
      ['duration_hours 1.5', moderator, { ...BAN, duration_hours: 1.5 }, 400],
      ['duration_hours 8761', moderator, { ...BAN, duration_hours: 8761 }, 400],
      [
        'an expires_at',
        moderator,
        { ...BAN, expires_at: '2030-01-01T00:00:00Z' },
        400,
      ],
      ['a created_by', moderator, { ...BAN, created_by: 'u-creator' }, 400],
      ['an unknown property', moderator, { ...BAN, unexpected: 1 }, 400],
    ] as const)(
      'refuses %s, changing nothing',
      async (_name, actor, body, status) => {
        await actor.ban(body).expect(status);
        expect(bans).toHaveLength(0);
        expect(subscriptions.has(key('c-a', 'u-member'))).toBe(true);
        expect(log).toHaveLength(0);
      },
    );

    it('answers an unknown community with 404, even for a stranger', async () => {
      await as('outsider').ban(BAN, 'no-such-community').expect(404);
    });

    it('refuses a second active ban with 409', async () => {
      await moderator.ban(BAN).expect(201);
      await creator.ban(BAN).expect(409);
      expect(bans).toHaveLength(1);
      expect(log).toHaveLength(1);
    });

    it('rolls the ban back when the log cannot be written', async () => {
      failLog = true;
      await moderator.ban(BAN).expect(500);
      expect(bans).toHaveLength(0);
      expect(subscriptions.has(key('c-a', 'u-member'))).toBe(true);
      expect(tx).toEqual({ commits: 0, rollbacks: 1, releases: 1 });
    });
  });

  describe('GET /communities/:name/bans', () => {
    beforeEach(async () => {
      await moderator.ban(BAN).expect(201);
      await moderator
        .ban({ ...BAN, username: 'platform_admin', duration_hours: 1 })
        .expect(201);
      await moderator.lift('platform_admin').expect(204);
      await moderator.ban({ ...BAN, username: 'outsider' }).expect(201);
      // A temporary ban that ran out unlifted.
      bans.push({
        id: 'expired',
        community_id: 'c-a',
        user_id: 'u-other-creator',
        reason: 'Old',
        created_by: 'u-mod',
        expires_at: NOW - 1000,
        lifted_at: null,
        lifted_by: null,
        lift_reason: null,
        created_at: NOW - 86_400_000,
      });
    });

    it('lists active bans by default, newest first', async () => {
      const body = listOf(await moderator.list().expect(200));
      expect(body).toMatchObject({ page: 1, limit: 20, total: 2 });
      expect(body.items.map((item) => item.username)).toEqual([
        'outsider',
        'member',
      ]);
    });

    it('lists what is no longer in force under lifted, and both under any', async () => {
      const lifted = listOf(await moderator.list('?active=lifted').expect(200));
      expect(lifted.items.map((item) => item.username).sort()).toEqual([
        'other_creator',
        'platform_admin',
      ]);
      expect(lifted.items.every((item) => !item.active)).toBe(true);
      expect(
        listOf(await moderator.list('?active=any').expect(200)).total,
      ).toBe(4);
    });

    it('renders a deleted moderator and a deleted member as null usernames', async () => {
      users.get('u-mod')!.deleted = true;
      users.get('u-member')!.deleted = true;
      const body = listOf(await creator.list('?active=any').expect(200));
      const memberBan = body.items.find((item) => item.id === bans[0].id);
      expect(memberBan).toMatchObject({
        username: null,
        created_by_username: null,
      });
    });

    it.each([
      ['no token', as(null), 401],
      ['a plain member', as('member'), 403],
      ['an outsider', as('outsider'), 403],
    ] as const)('refuses %s', async (_name, actor, status) => {
      await actor.list().expect(status);
    });

    it('answers an unknown community with 404 and a bad filter with 400', async () => {
      await moderator.list('', 'no-such-community').expect(404);
      await moderator.list('?active=true').expect(400);
      await moderator.list('?page=0').expect(400);
    });
  });

  describe('POST /communities/:name/bans/:username/lift', () => {
    it('lifts, records who and why, and does not restore membership', async () => {
      await moderator.ban(BAN).expect(201);
      await creator
        .lift('member', { lift_reason: 'Appeal accepted' })
        .expect(204);
      expect(bans[0]).toMatchObject({
        lifted_by: 'u-creator',
        lift_reason: 'Appeal accepted',
      });
      expect(bans[0].lifted_at).not.toBeNull();
      expect(subscriptions.has(key('c-a', 'u-member'))).toBe(false);
      expect(log.map(({ action }) => action)).toEqual([
        'member_banned',
        'member_unbanned',
      ]);
      // The way back in is the member's own.
      await as('member').subscribe().expect(204);
      expect(subscriptions.has(key('c-a', 'u-member'))).toBe(true);
    });

    it('lifts an expired temporary ban explicitly', async () => {
      await moderator.ban({ ...BAN, duration_hours: 1 }).expect(201);
      bans[0].expires_at = NOW - 1;
      expect(listOf(await moderator.list().expect(200)).total).toBe(0);
      await moderator.lift('member').expect(204);
    });

    it('answers 404 for a user never banned, and 409 once lifted', async () => {
      await moderator.lift('member').expect(404);
      await moderator.ban(BAN).expect(201);
      await moderator.lift('member').expect(204);
      await moderator.lift('member').expect(409);
      expect(log.map(({ action }) => action)).toEqual([
        'member_banned',
        'member_unbanned',
      ]);
    });

    it.each([
      ['no token', as(null), 'member', {}, 401],
      ['a plain member', as('member'), 'member', {}, 403],
      ['an unknown user', moderator, 'nobody', {}, 404],
      ['a malformed username', moderator, 'bad-name', {}, 400],
      ['a blank reason', moderator, 'member', { lift_reason: '' }, 400],
      ['an unknown property', moderator, 'member', { lifted_by: 'x' }, 400],
    ] as const)('refuses %s', async (_name, actor, username, body, status) => {
      await moderator.ban(BAN).expect(201);
      await actor.lift(username, body).expect(status);
      expect(bans[0].lifted_at).toBeNull();
    });
  });

  describe('POST /communities/:name/members/:username/remove', () => {
    it('ends the membership without a ban, and the member may rejoin at once', async () => {
      await moderator.remove('member').expect(204);
      expect(subscriptions.has(key('c-a', 'u-member'))).toBe(false);
      expect(subscriptions.has(key('c-b', 'u-member'))).toBe(true);
      expect(bans).toHaveLength(0);
      expect(log.map(({ action }) => action)).toEqual(['member_removed']);
      await as('member').subscribe().expect(204);
      expect(subscriptions.has(key('c-a', 'u-member'))).toBe(true);
    });

    it('is idempotent for a non-member, logging nothing', async () => {
      await moderator.remove('outsider').expect(204);
      await moderator.remove('outsider').expect(204);
      expect(log).toHaveLength(0);
    });

    it.each([
      ['no token', as(null), 'member', 401],
      ['a plain member', as('member'), 'platform_admin', 403],
      ['removing the creator', moderator, 'creator', 403],
      ['removing yourself', moderator, 'a_moderator', 400],
      ['a moderator removing a moderator', moderator, 'other_moderator', 403],
      ['the creator removing a moderator', creator, 'a_moderator', 409],
      ['an unknown user', moderator, 'nobody', 404],
    ] as const)('refuses %s', async (_name, actor, username, status) => {
      await actor.remove(username).expect(status);
      expect(log).toHaveLength(0);
      expect(subscriptions.size).toBe(5);
    });
  });

  it('releases the connection on success, 403, 404 and 409', async () => {
    await moderator.ban(BAN).expect(201);
    await moderator.ban({ ...BAN, username: 'creator' }).expect(403);
    await moderator.ban({ ...BAN, username: 'nobody' }).expect(404);
    await moderator.ban(BAN).expect(409);
    await moderator.lift('outsider').expect(404);
    await moderator.lift('member').expect(204);
    await moderator.lift('member').expect(409);
    await moderator.remove('creator').expect(403);
    await moderator.remove('platform_admin').expect(204);
    expect(tx.releases).toBe(9);
    expect(tx.commits + tx.rollbacks).toBe(9);
  });

  it('never serialises an email or password hash', async () => {
    const responses = [
      await moderator.ban(BAN).expect(201),
      await moderator.list('?active=any').expect(200),
      await moderator.lift('member').expect(204),
      await moderator.remove('platform_admin').expect(204),
    ];
    for (const response of responses) {
      expect(response.text).not.toMatch(/@example\.com|email|password/);
    }
  });

  describe('enforcement on rejoining', () => {
    const member = as('member');
    const leave = (community = 'a-community') =>
      request(app.getHttpServer())
        .delete(`/communities/${community}/subscribe`)
        .set('Authorization', 'Bearer member-token');

    it('refuses a banned user’s rejoin with the payload, and a lift lets them back', async () => {
      await moderator.ban(BAN).expect(201);
      const refused = await member.subscribe().expect(403);
      expect(refused.body).toEqual({
        reason: 'community_banned',
        community: 'a-community',
      });
      expect(subscriptions.has(key('c-a', 'u-member'))).toBe(false);

      await moderator.lift('member').expect(204);
      await member.subscribe().expect(204);
      expect(subscriptions.has(key('c-a', 'u-member'))).toBe(true);
    });

    it('tells a temporarily banned user when the ban ends', async () => {
      await moderator.ban({ ...BAN, duration_hours: 48 }).expect(201);
      const refused = await member.subscribe().expect(403);
      expect(refused.body).toEqual({
        reason: 'community_banned',
        community: 'a-community',
        expires_at: iso(NOW + 48 * 3_600_000),
      });
    });

    // The ban lapses by the predicate; nothing has to run.
    it('lets the user back the moment a temporary ban has expired', async () => {
      await moderator.ban({ ...BAN, duration_hours: 1 }).expect(201);
      bans[0].expires_at = NOW - 1;
      await member.subscribe().expect(204);
    });

    it('never discloses the ban reason, the moderator or the ban id', async () => {
      await moderator
        .ban({ ...BAN, reason: 'Harassed three members' })
        .expect(201);
      const refused = await member.subscribe().expect(403);
      expect(refused.text).not.toMatch(
        new RegExp(`Harassed|a_moderator|u-mod|${bans[0].id}|created_by|"id"`),
      );
    });

    it('is scoped to one community', async () => {
      await moderator.ban(BAN).expect(201);
      await member.subscribe('b-community').expect(204);
      expect(subscriptions.has(key('c-b', 'u-member'))).toBe(true);
    });

    it('lets a banned user leave, without consulting the ban', async () => {
      await moderator.ban(BAN).expect(201);
      const check = jest.spyOn(
        app.get(CommunityBanPolicyService),
        'assertNotBannedOrThrow',
      );
      await leave('b-community').expect(204);
      await leave().expect(204);
      expect(check).not.toHaveBeenCalled();
      check.mockRestore();
    });

    it('answers an unknown community with 404, not 403', async () => {
      await moderator.ban(BAN).expect(201);
      await member.subscribe('no-such-community').expect(404);
    });
  });
});
