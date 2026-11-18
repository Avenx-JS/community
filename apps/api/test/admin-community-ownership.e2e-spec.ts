import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ADMIN_COMMUNITY_DETAIL_SQL } from '../src/admin/admin-communities.service';
import {
  LOCK_STAFF_COMMUNITY_SQL,
  PREVIOUS_OWNER_SQL,
  STAFF_TARGET_SQL,
} from '../src/admin/admin-community-staff.service';
import { ACTIVE_RESTRICTION_SQL } from '../src/admin/admin-roles.service';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { ACTIVE_COMMUNITY_BAN_SQL } from '../src/common/active-community-ban';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import {
  REMOVE_MODERATOR_SQL,
  TRANSFER_CREATOR_SQL,
  TRANSFER_TARGET_MODERATOR_SQL,
} from '../src/communities/communities.service';
import {
  DELETE_MODERATOR_INVITE_SQL,
  INSERT_MODERATOR_SQL,
} from '../src/communities/community-moderator-invites.service';
import { UsersService } from '../src/users/users.service';

const REASON = 'The owner is banned; the moderators asked for help';

// The three /admin/communities/:id staff routes through the real service,
// over one store, with a suspended community whose owner is banned.
describe('Admin community ownership and moderators (e2e)', () => {
  let app: INestApplication<App>;
  const users = [
    { id: 'u-admin', username: 'root', deleted_at: null },
    { id: 'u-founder', username: 'founder', deleted_at: null },
    { id: 'u-heir', username: 'heir', deleted_at: null },
    { id: 'u-member', username: 'member', deleted_at: null },
  ];
  let community: { id: string; name: string; creator_id: string };
  let moderators: Map<string, string>;
  let audit: unknown[][];
  let modLog: unknown[][];
  let notifications: unknown[][];

  beforeEach(async () => {
    community = { id: 'k-1', name: 'garden', creator_id: 'u-founder' };
    moderators = new Map([['u-heir', 'u-founder']]);
    audit = [];
    modLog = [];
    notifications = [];

    const result = (rows: unknown) => Promise.resolve([rows, []]);
    const run = (sql: string, values: unknown[] = []) => {
      const [first, second, third] = values as string[];
      if (sql === LOCK_STAFF_COMMUNITY_SQL) {
        return result(
          first === community.id ? [{ ...community, deleted_at: null }] : [],
        );
      }
      if (sql === STAFF_TARGET_SQL) {
        return result(users.filter((user) => user.username === first));
      }
      if (sql === ACTIVE_RESTRICTION_SQL || sql === ACTIVE_COMMUNITY_BAN_SQL) {
        return result([]);
      }
      if (sql === PREVIOUS_OWNER_SQL) {
        // The founder is banned from the platform.
        return result(
          users
            .filter((user) => user.id === first)
            .map((user) => ({
              ...user,
              banned: user.id === 'u-founder' ? 1 : 0,
            })),
        );
      }
      if (sql === TRANSFER_CREATOR_SQL) {
        const moved = community.creator_id === third;
        if (moved) community.creator_id = first;
        return result({ affectedRows: moved ? 1 : 0 });
      }
      if (sql === TRANSFER_TARGET_MODERATOR_SQL) {
        return result(moderators.has(second) ? [{ user_id: second }] : []);
      }
      if (sql === REMOVE_MODERATOR_SQL) {
        return result({ affectedRows: moderators.delete(second) ? 1 : 0 });
      }
      if (sql === INSERT_MODERATOR_SQL) {
        moderators.set(second, third);
        return result({ affectedRows: 1 });
      }
      if (sql === DELETE_MODERATOR_INVITE_SQL) {
        return result({ affectedRows: 0 });
      }
      if (sql === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
        return result(users.filter((user) => user.id === first));
      }
      if (sql.startsWith('INSERT INTO admin_actions')) {
        audit.push(values);
        return result({ affectedRows: 1 });
      }
      if (
        sql.trimStart().startsWith('INSERT INTO community_moderation_actions')
      ) {
        modLog.push(values);
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('INSERT INTO notifications')) {
        notifications.push(values);
        return result({ affectedRows: 1 });
      }
      if (sql === ADMIN_COMMUNITY_DETAIL_SQL) {
        return result([
          {
            id: community.id,
            name: community.name,
            description: null,
            creator_username: users.find((u) => u.id === community.creator_id)
              ?.username,
            created_at: new Date('2026-01-01T00:00:00Z'),
            suspended_at: new Date('2026-11-01T00:00:00Z'),
            deleted_at: null,
            suspended_by_username: 'root',
            suspension_reason: 'Abandoned',
            deleted_by_username: null,
            member_count: 3,
            post_count: 0,
            moderator_count: moderators.size,
            comment_count: 0,
            rule_version: null,
            open_report_count: 0,
          },
        ]);
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
            beginTransaction: () => Promise.resolve(),
            commit: () => Promise.resolve(),
            rollback: () => Promise.resolve(),
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
            (entry) => `${entry.username}-token` === token,
          );
          return Promise.resolve(
            user
              ? { kind: 'valid', emailVerified: true, userId: user.id }
              : { kind: 'invalid' },
          );
        },
      })
      .overrideProvider(UsersService)
      .useValue({
        getPlatformRole: (userId: string) =>
          Promise.resolve(userId === 'u-admin' ? 'admin' : 'user'),
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

  const as = (token: string | null) => {
    const auth = (test: request.Test) =>
      token === null ? test : test.set('Authorization', `Bearer ${token}`);
    const server = () => request(app.getHttpServer());
    return {
      owner: (body: object, id = 'k-1') =>
        auth(server().post(`/admin/communities/${id}/owner`)).send(body),
      add: (body: object, id = 'k-1') =>
        auth(server().post(`/admin/communities/${id}/moderators`)).send(body),
      remove: (username: string, body: object, id = 'k-1') =>
        auth(
          server().delete(`/admin/communities/${id}/moderators/${username}`),
        ).send(body),
    };
  };
  const admin = as('root-token');

  it.each([
    [
      'owner',
      (a: ReturnType<typeof as>) =>
        a.owner({ username: 'heir', reason: REASON }),
    ],
    [
      'add',
      (a: ReturnType<typeof as>) =>
        a.add({ username: 'member', reason: REASON }),
    ],
    [
      'remove',
      (a: ReturnType<typeof as>) => a.remove('heir', { reason: REASON }),
    ],
  ])('%s: 401 without a token, 403 for a member', async (_, call) => {
    await call(as(null)).expect(401);
    await call(as('heir-token')).expect(403);
    expect(audit).toEqual([]);
    expect(community.creator_id).toBe('u-founder');
  });

  it('answers 404 for an unknown community', async () => {
    await admin.owner({ username: 'heir', reason: REASON }, 'nope').expect(404);
    await admin.add({ username: 'heir', reason: REASON }, 'nope').expect(404);
    await admin.remove('heir', { reason: REASON }, 'nope').expect(404);
  });

  it('reassigns the owner of a suspended community, in both logs with the reason', async () => {
    const response = await admin
      .owner({ username: 'heir', reason: `  ${REASON}  ` })
      .expect(200);
    expect(response.body).toMatchObject({
      id: 'k-1',
      creator_username: 'heir',
      suspended_at: '2026-11-01T00:00:00.000Z',
    });
    expect(community.creator_id).toBe('u-heir');
    // The banned founder gets no moderator row; the heir's own row is gone.
    expect([...moderators.keys()]).toEqual([]);

    expect(audit).toHaveLength(1);
    expect(audit[0].slice(1, 6)).toEqual([
      'u-admin',
      'root',
      'community_owner_changed',
      'community',
      'k-1',
    ]);
    expect(JSON.parse(audit[0][6] as string)).toEqual({
      community_name: 'garden',
      username: 'heir',
      previous_owner_username: 'founder',
      reason: REASON,
    });
    expect(modLog).toHaveLength(1);
    expect(modLog[0]).toEqual(
      expect.arrayContaining([
        'admin_owner_changed',
        'u-heir',
        JSON.stringify({ username: 'heir', reason: REASON }),
      ]),
    );
    expect(notifications.map((row) => [row[1], row[2], row[3]])).toEqual([
      ['u-heir', 'community_ownership_assigned', null],
      ['u-founder', 'community_ownership_revoked', null],
    ]);
  });

  it('adds and removes a moderator directly, idempotently, never the owner', async () => {
    await admin.add({ username: 'member', reason: REASON }).expect(204, '');
    await admin.add({ username: 'member', reason: REASON }).expect(204);
    expect(moderators.get('u-member')).toBe('u-admin');

    await admin.remove('member', { reason: REASON }).expect(204);
    await admin.remove('member', { reason: REASON }).expect(204);
    await admin.remove('founder', { reason: REASON }).expect(409);
    await admin.remove('nobody', { reason: REASON }).expect(404);

    expect(audit.map((row) => row[3])).toEqual([
      'community_moderator_added',
      'community_moderator_removed',
    ]);
    expect(
      modLog.map((row) =>
        row.find((v) => typeof v === 'string' && v.startsWith('admin_')),
      ),
    ).toEqual(['admin_moderator_added', 'admin_moderator_removed']);
    expect(notifications.map((row) => row[2])).toEqual([
      'community_moderator_assigned',
    ]);
  });

  it.each([
    [{ username: 'heir' }],
    [{ username: 'heir', reason: '' }],
    [{ username: 'heir', reason: '   ' }],
    [{ username: 'heir', reason: 'x'.repeat(2001) }],
    [{ username: 'bad name', reason: REASON }],
    [{ username: 'heir', reason: REASON, keep_previous: false }],
  ])('rejects the body %o with 400', async (body) => {
    await admin.owner(body).expect(400);
    await admin.add(body).expect(400);
    expect(audit).toEqual([]);
  });

  it('requires a reason to remove', async () => {
    await admin.remove('heir', {}).expect(400);
    expect(moderators.has('u-heir')).toBe(true);
  });
});
