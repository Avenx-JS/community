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
import { ACTIVE_COMMUNITY_BAN_SQL } from '../src/common/active-community-ban';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import {
  OWNER_USERNAME_SQL,
  REMOVE_MODERATOR_SQL,
  TRANSFER_CREATOR_SQL,
  TRANSFER_TARGET_MODERATOR_SQL,
  TRANSFER_TARGET_RESTRICTION_SQL,
  TRANSFER_TARGET_SQL,
} from '../src/communities/communities.service';
import { INSERT_MODERATOR_SQL } from '../src/communities/community-moderator-invites.service';
import {
  ANONYMISE_ACCOUNT_SQL,
  COMMUNITY_CREATOR_MESSAGE,
  CREATED_COMMUNITY_SQL,
  DELETE_PRIVATE_STATE_SQL,
  LOCK_ACCOUNT_SQL,
} from '../src/users/account-deletion.service';
import { ACTIVE_ADMINS_SQL } from '../src/users/users.service';

interface FakeUser {
  id: string;
  username: string;
  deleted_at: Date | null;
}

// POST /communities/:name/transfer through the real CommunitiesService, then
// DELETE /users/me through the real AccountDeletionService, over one store.
describe('Community ownership transfer (e2e)', () => {
  let app: INestApplication<App>;
  let users: FakeUser[];
  let community: { id: string; name: string; creator_id: string } | null;
  let moderators: Array<{ user_id: string; assigned_by: string }>;
  let banned: Set<string>;
  let restricted: Set<string>;
  let logEntries: unknown[][];
  let notifications: unknown[][];
  let rollbacks: number;

  beforeEach(async () => {
    users = [
      { id: 'u-founder', username: 'founder', deleted_at: null },
      { id: 'u-heir', username: 'heir', deleted_at: null },
      { id: 'u-member', username: 'member', deleted_at: null },
      { id: 'u-banned', username: 'banned_mod', deleted_at: null },
      { id: 'u-suspended', username: 'suspended_mod', deleted_at: null },
      { id: 'u-gone', username: 'gone', deleted_at: new Date() },
    ];
    community = { id: 'k-1', name: 'garden', creator_id: 'u-founder' };
    moderators = ['u-heir', 'u-banned', 'u-suspended', 'u-gone'].map(
      (user_id) => ({ user_id, assigned_by: 'u-founder' }),
    );
    banned = new Set(['u-banned']);
    restricted = new Set(['u-suspended']);
    logEntries = [];
    notifications = [];
    rollbacks = 0;
    let before = '';

    const result = (rows: unknown) => Promise.resolve([rows, []]);
    const run = (sql: string, values: unknown[] = []) => {
      const [first, second, third] = values as string[];
      if (
        sql.startsWith(
          'SELECT id, creator_id, visibility FROM communities WHERE name = ?',
        )
      ) {
        return result(
          community && community.name === first
            ? [{ ...community, visibility: 'public' }]
            : [],
        );
      }
      if (sql === TRANSFER_TARGET_SQL) {
        return result(users.filter((user) => user.username === first));
      }
      if (sql === TRANSFER_TARGET_RESTRICTION_SQL) {
        return result(restricted.has(first) ? [{ id: 'r-1' }] : []);
      }
      if (sql === ACTIVE_COMMUNITY_BAN_SQL) {
        return result(banned.has(second) ? [{ id: 'b-1' }] : []);
      }
      if (sql === TRANSFER_TARGET_MODERATOR_SQL) {
        return result(moderators.filter((row) => row.user_id === second));
      }
      if (sql === TRANSFER_CREATOR_SQL) {
        const moved = community!.creator_id === third;
        if (moved) community!.creator_id = first;
        return result({ affectedRows: moved ? 1 : 0 });
      }
      if (sql === REMOVE_MODERATOR_SQL) {
        moderators = moderators.filter((row) => row.user_id !== second);
        return result({ affectedRows: 1 });
      }
      if (sql === INSERT_MODERATOR_SQL) {
        moderators.push({ user_id: second, assigned_by: third });
        return result({ affectedRows: 1 });
      }
      if (
        sql === OWNER_USERNAME_SQL ||
        sql === 'SELECT username FROM users WHERE id = ? LIMIT 1'
      ) {
        return result(users.filter((user) => user.id === first));
      }
      if (
        sql.trimStart().startsWith('INSERT INTO community_moderation_actions')
      ) {
        logEntries.push(values);
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('INSERT INTO notifications')) {
        notifications.push(values);
        return result({ affectedRows: 1 });
      }
      // Account deletion.
      if (sql === LOCK_ACCOUNT_SQL) {
        return result(
          users
            .filter((user) => user.id === first)
            .map((user) => ({ ...user, password_hash: 'hash' })),
        );
      }
      if (sql === CREATED_COMMUNITY_SQL) {
        return result(
          community?.creator_id === first ? [{ id: community.id }] : [],
        );
      }
      if (sql === ACTIVE_ADMINS_SQL) return result([]);
      if (sql === ANONYMISE_ACCOUNT_SQL) {
        users.find((user) => user.id === values[3])!.deleted_at = new Date();
        return result({ affectedRows: 1 });
      }
      if ((DELETE_PRIVATE_STATE_SQL as readonly string[]).includes(sql)) {
        return result({ affectedRows: 0 });
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
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
              before = JSON.stringify({ community, moderators });
              return Promise.resolve();
            },
            commit: () => Promise.resolve(),
            rollback: () => {
              rollbacks += 1;
              ({ community, moderators } = JSON.parse(before) as {
                community: typeof community;
                moderators: typeof moderators;
              });
              return Promise.resolve();
            },
            release: () => undefined,
            execute: run,
          }),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) => {
          const user = users.find(
            (entry) => `${entry.username}-token` === token && !entry.deleted_at,
          );
          return Promise.resolve(
            user
              ? { kind: 'valid', emailVerified: true, userId: user.id }
              : { kind: 'invalid' },
          );
        },
        passwordMatches: () => Promise.resolve(true),
        revokeAllSessions: () => Promise.resolve(),
        announceSessionsChanged: () => undefined,
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
    await app.close();
  });

  const transfer = (
    token: string | null,
    body: object = { username: 'heir', confirm_name: 'garden' },
    name = 'garden',
  ) => {
    const test = request(app.getHttpServer()).post(
      `/communities/${name}/transfer`,
    );
    return (token ? test.set('Authorization', `Bearer ${token}`) : test).send(
      body,
    );
  };
  const deleteAccount = (token: string) =>
    request(app.getHttpServer())
      .delete('/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'correct horse battery' });

  const unchanged = () => {
    expect(community?.creator_id).toBe('u-founder');
    expect(logEntries).toEqual([]);
    expect(notifications).toEqual([]);
  };

  it('transfers to a moderator, keeping the former owner as one, then lets them delete their account', async () => {
    const refused = await deleteAccount('founder-token').expect(409);
    expect((refused.body as { message: string }).message).toBe(
      COMMUNITY_CREATOR_MESSAGE,
    );

    await transfer('founder-token').expect(204, '');

    expect(community?.creator_id).toBe('u-heir');
    expect(moderators).toContainEqual({
      user_id: 'u-founder',
      assigned_by: 'u-heir',
    });
    expect(moderators.map((row) => row.user_id)).not.toContain('u-heir');
    expect(logEntries).toHaveLength(1);
    expect(logEntries[0]).toEqual(
      expect.arrayContaining([
        'u-founder',
        'founder',
        'ownership_transferred',
        'user',
        'u-heir',
        JSON.stringify({ username: 'heir' }),
      ]),
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].slice(1, 7)).toEqual([
      'u-heir',
      'community_ownership_transferred',
      'u-founder',
      'community',
      'k-1',
      'k-1',
    ]);
    expect(JSON.parse(notifications[0][7] as string)).toEqual({
      actor_username: 'founder',
      community_name: 'garden',
    });

    // The former owner is a moderator now, not the creator.
    await transfer('founder-token', {
      username: 'member',
      confirm_name: 'garden',
    }).expect(403);
    await deleteAccount('founder-token').expect(204);
    expect(community).toMatchObject({ creator_id: 'u-heir' });
  });

  it('answers 401 without a token', async () => {
    await transfer(null).expect(401);
    unchanged();
  });

  it('answers 404 for an unknown community before 403', async () => {
    await transfer(
      'member-token',
      { username: 'heir', confirm_name: 'nope' },
      'nope',
    ).expect(404);
    await transfer('heir-token').expect(403);
    unchanged();
  });

  it.each([
    ['an unknown user', { username: 'nobody' }, 404],
    ['a deleted user', { username: 'gone' }, 404],
    ['yourself', { username: 'founder' }, 400],
    ['a platform-suspended moderator', { username: 'suspended_mod' }, 409],
    ['a moderator banned from the community', { username: 'banned_mod' }, 409],
    ['a member who is not a moderator', { username: 'member' }, 409],
  ])('refuses a transfer to %s', async (_, body, status) => {
    await transfer('founder-token', { confirm_name: 'garden', ...body }).expect(
      status,
    );
    unchanged();
    expect(moderators).toHaveLength(4);
  });

  it.each([
    [{ username: 'heir' }],
    [{ username: 'heir', confirm_name: 'Garden' }],
    [{ username: 'heir', confirm_name: '' }],
    [{ username: 'bad name', confirm_name: 'garden' }],
    [{ username: 'heir', confirm_name: 'garden', keep_moderator: false }],
  ])('rejects the body %o with 400', async (body) => {
    await transfer('founder-token', body).expect(400);
    unchanged();
    expect(rollbacks).toBe(0);
  });
});
