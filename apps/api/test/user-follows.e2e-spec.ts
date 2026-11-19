import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { ApiRateLimitInterceptor } from '../src/common/api-rate-limit.interceptor';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import { USER_ID_BY_USERNAME_SQL } from '../src/users/user-activity.service';
import { BLOCKED_BETWEEN_SQL } from '../src/users/user-block-policy.service';
import {
  FOLLOW_SQL,
  FOLLOW_STATUS_SQL,
  followCountSql,
  followListSql,
  LOCK_FOLLOW_PARTY_SQL,
  NOTIFY_NEW_FOLLOWERS_SQL,
  UNFOLLOW_SQL,
} from '../src/users/user-follows.service';

interface Account {
  id: string;
  username: string;
  deleted_at: Date | null;
}
interface Follow {
  follower_id: string;
  followee_id: string;
  created_at: Date;
}

// The follow routes through the real controller, services and rate limiter
// (the app's own store), over a fake pool evaluating the statements the
// services send by the rules their SQL states (user-follows.mysql.spec.ts
// checks the SQL itself on a real server).
describe('User follows (e2e)', () => {
  let app: INestApplication<App>;
  let accounts: Account[];
  let follows: Follow[];
  let blocks: Array<[string, string]>;
  let notifications: unknown[][];
  let preferences: Map<string, boolean>;
  let clock: number;
  const previous = {
    max: process.env.API_FOLLOW_ACCOUNT_MAX,
    window: process.env.API_FOLLOW_ACCOUNT_WINDOW_SECONDS,
  };

  const blockedBetween = (a: unknown, b: unknown) =>
    blocks.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const live = (id: string) =>
    accounts.find((a) => a.id === id && a.deleted_at === null);

  const listed = (side: 'followers' | 'following', values: unknown[]) => {
    const [userId, viewerId] = values;
    return follows
      .filter((f) =>
        side === 'followers'
          ? f.followee_id === userId
          : f.follower_id === userId,
      )
      .map((f) => ({
        f,
        u: live(side === 'followers' ? f.follower_id : f.followee_id),
      }))
      .filter(
        ({ u }) =>
          u && (viewerId === undefined || !blockedBetween(u.id, viewerId)),
      )
      .sort((a, b) => b.f.created_at.getTime() - a.f.created_at.getTime());
  };

  const execute = (sql: string, values: unknown[] = []) => {
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
    if (sql === BLOCKED_BETWEEN_SQL) {
      return Promise.resolve([
        [{ blocked: blockedBetween(values[0], values[1]) ? 1 : 0 }],
        [],
      ]);
    }
    if (sql === FOLLOW_SQL) {
      const [follower_id, followee_id] = values as string[];
      if (
        follows.some(
          (f) => f.follower_id === follower_id && f.followee_id === followee_id,
        )
      ) {
        return Promise.resolve([{ affectedRows: 0 }, []]);
      }
      clock += 1000;
      follows.push({ follower_id, followee_id, created_at: new Date(clock) });
      return Promise.resolve([{ affectedRows: 1 }, []]);
    }
    if (sql === UNFOLLOW_SQL) {
      const before = follows.length;
      follows = follows.filter(
        (f) => !(f.follower_id === values[0] && f.followee_id === values[1]),
      );
      return Promise.resolve([{ affectedRows: before - follows.length }, []]);
    }
    if (sql === NOTIFY_NEW_FOLLOWERS_SQL) {
      const value = preferences.get(values[0] as string);
      return Promise.resolve([
        value === undefined ? [] : [{ notify_new_followers: value ? 1 : 0 }],
        [],
      ]);
    }
    if (sql.startsWith('INSERT INTO notifications')) {
      notifications.push(values);
      return Promise.resolve([{ affectedRows: 1 }, []]);
    }
    if (sql === FOLLOW_STATUS_SQL) {
      const has = (a: unknown, b: unknown) =>
        follows.some((f) => f.follower_id === a && f.followee_id === b);
      return Promise.resolve([
        [
          {
            following: has(values[0], values[1]) ? 1 : 0,
            followed_by: has(values[2], values[3]) ? 1 : 0,
          },
        ],
        [],
      ]);
    }
    for (const side of ['followers', 'following'] as const) {
      for (const viewer of [false, true]) {
        const filter = values.slice(0, viewer ? 3 : 1);
        if (sql === followListSql(side, viewer)) {
          const [limit, offset] = values.slice(-2) as number[];
          return Promise.resolve([
            listed(side, filter)
              .slice(offset, offset + limit)
              .map(({ f, u }) => ({
                username: u!.username,
                display_name: null,
                avatar_media_id: null,
                followed_at: f.created_at,
              })),
            [],
          ]);
        }
        if (sql === followCountSql(side, viewer)) {
          return Promise.resolve([
            [{ total: listed(side, filter).length }],
            [],
          ]);
        }
      }
    }
    return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
  };

  beforeEach(async () => {
    process.env.API_FOLLOW_ACCOUNT_MAX = '5';
    process.env.API_FOLLOW_ACCOUNT_WINDOW_SECONDS = '3600';
    accounts = [
      { id: 'u-a', username: 'alice', deleted_at: null },
      { id: 'u-b', username: 'bob', deleted_at: null },
      { id: 'u-c', username: 'carol', deleted_at: null },
      { id: 'u-gone', username: 'gone_user', deleted_at: new Date() },
    ];
    follows = [];
    blocks = [];
    notifications = [];
    preferences = new Map();
    clock = Date.parse('2026-11-01T10:00:00.000Z');
    const connection = {
      execute,
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
    };
    const tokens: Record<string, string> = {
      'token-a': 'u-a',
      'token-b': 'u-b',
      'token-c': 'u-c',
    };
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({ execute, getConnection: () => Promise.resolve(connection) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            tokens[token]
              ? { kind: 'valid', emailVerified: true, userId: tokens[token] }
              : { kind: 'invalid' },
          ),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
    // As main.ts registers it.
    app.useGlobalInterceptors(
      new ApiRateLimitInterceptor(app.get(AuthRateLimitService)),
    );
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
    await app.close();
    for (const [name, value] of [
      ['API_FOLLOW_ACCOUNT_MAX', previous.max],
      ['API_FOLLOW_ACCOUNT_WINDOW_SECONDS', previous.window],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const server = () => request(app.getHttpServer());
  const as = <T extends request.Test>(test: T, token?: string) =>
    token ? test.set('Authorization', `Bearer ${token}`) : test;
  const follow = (username: string, token?: string) =>
    as(server().post(`/users/${username}/follow`), token);
  const unfollow = (username: string, token?: string) =>
    as(server().delete(`/users/${username}/follow`), token);
  const list = (path: string, token?: string) =>
    as(server().get(`/users/${path}`), token);

  it('needs a token to follow, unfollow or ask the status', async () => {
    await follow('bob').expect(401);
    await unfollow('bob').expect(401);
    await list('bob/follow-status').expect(401);
    expect(follows).toEqual([]);
  });

  it('follows once, idempotently, notifying the followee once', async () => {
    await follow('bob', 'token-a').expect(204);
    await follow('bob', 'token-a').expect(204);
    expect(
      follows.map(({ follower_id, followee_id }) => [follower_id, followee_id]),
    ).toEqual([['u-a', 'u-b']]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].slice(1, 7)).toEqual([
      'u-b',
      'new_follower',
      'u-a',
      'user',
      'u-a',
      null,
    ]);
    expect(JSON.parse(notifications[0][7] as string)).toEqual({
      actor_username: 'alice',
    });
  });

  it('does not notify a followee who turned notify_new_followers off', async () => {
    preferences.set('u-b', false);
    await follow('bob', 'token-a').expect(204);
    expect(follows).toHaveLength(1);
    expect(notifications).toEqual([]);
  });

  it('refuses yourself with 400', async () => {
    await follow('alice', 'token-a').expect(400);
    expect(follows).toEqual([]);
  });

  it.each(['nobody', 'gone_user'])('answers 404 for %s', async (username) => {
    await follow(username, 'token-a').expect(404);
    await unfollow(username, 'token-a').expect(404);
    await list(`${username}/followers`).expect(404);
    await list(`${username}/following`).expect(404);
    await list(`${username}/follow-status`, 'token-a').expect(404);
  });

  it.each([
    ['the caller blocked the user', ['u-a', 'u-b']],
    ['the user blocked the caller', ['u-b', 'u-a']],
  ] as const)(
    'answers the same 403 when %s',
    async (_case, [blocker, blocked]) => {
      blocks = [[blocker, blocked]];
      const response = await follow('bob', 'token-a').expect(403);
      expect(response.body).toMatchObject({ reason: 'user_blocked' });
      expect(JSON.stringify(response.body)).not.toMatch(/u-a|u-b|alice|bob/);
      expect(follows).toEqual([]);
      expect(notifications).toEqual([]);
    },
  );

  it('unfollows, idempotently', async () => {
    await follow('bob', 'token-a').expect(204);
    await unfollow('bob', 'token-a').expect(204);
    await unfollow('bob', 'token-a').expect(204);
    expect(follows).toEqual([]);
  });

  it('lists followers and following, newest first, paged', async () => {
    await follow('carol', 'token-a').expect(204);
    await follow('carol', 'token-b').expect(204);
    await follow('bob', 'token-a').expect(204);

    const followers = await list('carol/followers').expect(200);
    expect(followers.body).toEqual({
      items: [
        {
          username: 'bob',
          display_name: null,
          avatar_url: null,
          followed_at: '2026-11-01T10:00:02.000Z',
        },
        {
          username: 'alice',
          display_name: null,
          avatar_url: null,
          followed_at: '2026-11-01T10:00:01.000Z',
        },
      ],
      page: 1,
      limit: 20,
      total: 2,
    });
    const page = await list('carol/followers?page=2&limit=1').expect(200);
    expect(page.body).toMatchObject({
      items: [{ username: 'alice' }],
      page: 2,
      limit: 1,
      total: 2,
    });
    const following = await list('alice/following').expect(200);
    expect(
      (following.body as { items: Array<{ username: string }> }).items.map(
        ({ username }) => username,
      ),
    ).toEqual(['bob', 'carol']);
  });

  it('leaves out deleted accounts, and for a viewer accounts blocked either way', async () => {
    await follow('carol', 'token-a').expect(204);
    await follow('carol', 'token-b').expect(204);
    blocks = [['u-b', 'u-c']];
    accounts[0].deleted_at = new Date();
    // bob blocked carol after following her: a follower of carol, listed to
    // anonymous readers, but not to carol herself.
    await list('carol/followers').expect(200);
    expect((await list('carol/followers')).body).toMatchObject({
      items: [{ username: 'bob' }],
      total: 1,
    });
    expect((await list('carol/followers', 'token-c')).body).toMatchObject({
      items: [],
      total: 0,
    });
  });

  it.each(['?limit=0', '?limit=101', '?page=0', '?sort=new'])(
    'rejects the list query %p with 400',
    async (query) => {
      await list(`bob/followers${query}`).expect(400);
    },
  );

  it('reports the follow status both ways', async () => {
    await follow('bob', 'token-a').expect(204);
    expect((await list('bob/follow-status', 'token-a')).body).toEqual({
      following: true,
      followed_by: false,
    });
    expect((await list('alice/follow-status', 'token-b')).body).toEqual({
      following: false,
      followed_by: true,
    });
    expect((await list('alice/follow-status', 'token-a')).body).toEqual({
      following: false,
      followed_by: false,
    });
  });

  // Its own per-account bucket (API_FOLLOW_ACCOUNT_*), here 5.
  it('limits follows per account, answering 429 with Retry-After', async () => {
    for (let i = 0; i < 5; i += 1) {
      await follow('bob', 'token-a').expect(204);
    }
    const limited = await follow('bob', 'token-a').expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Unfollowing is not counted against it.
    await unfollow('bob', 'token-a').expect(204);
    // Another account has its own bucket.
    await follow('carol', 'token-b').expect(204);
  });
});
