import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import { COMMUNITY_ROLE_BY_NAME_SQL } from '../src/communities/community-access';
import {
  CREATOR_CANNOT_LEAVE_MESSAGE,
  LEAVE_MODERATION_SQL,
  MODERATOR_USERNAME_SQL,
} from '../src/communities/community-moderator-invites.service';

interface LogRow {
  id: string;
  action: string;
  actor_username: string;
  target_type: string;
  target_id: string;
  metadata: string | null;
  created_at: Date;
}

// DELETE /communities/:name/moderators/me through the real service, and the
// moderation log read through the real route, over one store: the log shows
// the step-down, and the former moderator loses the log at once.
describe('Moderator step-down (e2e)', () => {
  let app: INestApplication<App>;
  const users = [
    { id: 'u-founder', username: 'founder' },
    { id: 'u-mod', username: 'mod_one' },
    { id: 'u-suspended', username: 'suspended_mod' },
    { id: 'u-member', username: 'member' },
  ];
  let moderators: Set<string>;
  let logRows: LogRow[];
  let notifications: unknown[][];

  beforeEach(async () => {
    moderators = new Set(['u-mod', 'u-suspended']);
    logRows = [];
    notifications = [];
    const community = { id: 'k-1', name: 'garden', creator_id: 'u-founder' };
    const canModerate = (userId: string) =>
      userId === community.creator_id || moderators.has(userId) ? 1 : 0;

    const result = (rows: unknown) => Promise.resolve([rows, []]);
    const run = (sql: string, values: unknown[] = []) => {
      const [first, second, third] = values as string[];
      if (sql === `${COMMUNITY_ROLE_BY_NAME_SQL} FOR UPDATE`) {
        return result(
          third === community.name
            ? [
                {
                  ...community,
                  visibility: 'public',
                  can_moderate: canModerate(first),
                },
              ]
            : [],
        );
      }
      if (sql === LEAVE_MODERATION_SQL) {
        const had = moderators.delete(second);
        return result({ affectedRows: had ? 1 : 0 });
      }
      if (
        sql === MODERATOR_USERNAME_SQL ||
        sql === 'SELECT username FROM users WHERE id = ? LIMIT 1'
      ) {
        return result(users.filter((user) => user.id === first));
      }
      if (
        sql.trimStart().startsWith('INSERT INTO community_moderation_actions')
      ) {
        // id, community, actor id, actor username, action, target type,
        // target id, metadata.
        const [id, , , actorUsername, action, targetType, targetId, metadata] =
          values as string[];
        logRows.push({
          id: id ?? randomUUID(),
          action,
          actor_username: actorUsername,
          target_type: targetType,
          target_id: targetId,
          metadata,
          created_at: new Date('2026-11-18T10:00:00Z'),
        });
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('INSERT INTO notifications')) {
        notifications.push(values);
        return result({ affectedRows: 1 });
      }
      // GET /communities/:name/moderation-log.
      if (sql.startsWith('SELECT c.id, EXISTS (')) {
        return result(
          third === community.name
            ? [{ id: community.id, can_moderate: canModerate(first) }]
            : [],
        );
      }
      if (sql.startsWith('SELECT id, action, actor_username')) {
        return result(logRows);
      }
      if (
        sql.startsWith(
          'SELECT COUNT(*) AS total FROM community_moderation_actions',
        )
      ) {
        return result([{ total: logRows.length }]);
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
          if (!user) return Promise.resolve({ kind: 'invalid' });
          return Promise.resolve(
            user.id === 'u-suspended'
              ? {
                  kind: 'restricted',
                  userId: user.id,
                  restriction: {
                    type: 'suspension',
                    expires_at: '2026-12-01T00:00:00.000Z',
                  },
                }
              : { kind: 'valid', emailVerified: true, userId: user.id },
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
    await app.close();
  });

  const as = (token: string | null) => {
    const auth = (test: request.Test) =>
      token === null ? test : test.set('Authorization', `Bearer ${token}`);
    return {
      stepDown: (name = 'garden') =>
        auth(
          request(app.getHttpServer()).delete(
            `/communities/${name}/moderators/me`,
          ),
        ),
      log: () =>
        auth(
          request(app.getHttpServer()).get(
            '/communities/garden/moderation-log',
          ),
        ),
    };
  };

  it('steps down, shows in the moderation log, notifies the creator, and ends access at once', async () => {
    await as('mod_one-token').log().expect(200);

    await as('mod_one-token').stepDown().expect(204, '');

    expect(moderators.has('u-mod')).toBe(false);
    await as('mod_one-token').log().expect(403);

    const log = await as('founder-token').log().expect(200);
    expect(log.body).toMatchObject({
      total: 1,
      items: [
        {
          action: 'moderator_left',
          actor_username: 'mod_one',
          target_type: 'user',
          target_id: 'u-mod',
          metadata: { username: 'mod_one' },
        },
      ],
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].slice(1, 7)).toEqual([
      'u-founder',
      'community_moderator_left',
      'u-mod',
      'community',
      'k-1',
      'k-1',
    ]);
    expect(JSON.parse(notifications[0][7] as string)).toEqual({
      actor_username: 'mod_one',
      community_name: 'garden',
    });
  });

  it('is idempotent: a repeat, or a caller who never moderated, gets 204 and writes nothing more', async () => {
    await as('mod_one-token').stepDown().expect(204);
    await as('mod_one-token').stepDown().expect(204);
    await as('member-token').stepDown().expect(204);
    expect(logRows).toHaveLength(1);
    expect(notifications).toHaveLength(1);
  });

  it('refuses the creator with 409, pointing at transfer and deletion', async () => {
    const response = await as('founder-token').stepDown().expect(409);
    expect((response.body as { message: string }).message).toBe(
      CREATOR_CANNOT_LEAVE_MESSAGE,
    );
    expect(logRows).toEqual([]);
  });

  it('lets a suspended moderator step down', async () => {
    await as('suspended_mod-token').stepDown().expect(204);
    expect(moderators.has('u-suspended')).toBe(false);
    expect(logRows.map((row) => row.action)).toEqual(['moderator_left']);
  });

  it('answers 401 without a token and 404 for an unknown community', async () => {
    await as(null).stepDown().expect(401);
    await as('mod_one-token').stepDown('nope').expect(404);
    expect(moderators.has('u-mod')).toBe(true);
  });
});
