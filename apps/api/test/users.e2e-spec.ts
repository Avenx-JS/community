import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { ApiRateLimitInterceptor } from '../src/common/api-rate-limit.interceptor';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import {
  ANONYMISE_ACCOUNT_SQL,
  COMMUNITY_CREATOR_MESSAGE,
  CREATED_COMMUNITY_SQL,
  LOCK_ACCOUNT_SQL,
} from '../src/users/account-deletion.service';

type UserFixture = Record<string, string | Date | null>;
type Row = Record<string, unknown>;

const tokens: Record<
  string,
  | { kind: 'valid'; userId: string }
  | {
      kind: 'restricted';
      userId: string;
      restriction: { type: 'suspension' | 'ban'; expires_at: string | null };
    }
> = {
  'token-a': { kind: 'valid', userId: 'user-a' },
  'token-b': { kind: 'valid', userId: 'user-b' },
  'token-suspended': {
    kind: 'restricted',
    userId: 'user-suspended',
    restriction: {
      type: 'suspension',
      expires_at: '2026-11-01T00:00:00.000Z',
    },
  },
  'token-banned': {
    kind: 'restricted',
    userId: 'user-banned',
    restriction: { type: 'ban', expires_at: null },
  },
};

// Every column of users plus the credential and session columns a careless
// SELECT * or join would leak.
const account = (id: string, username: string): UserFixture => ({
  id,
  username,
  email: `${username}@example.com`,
  password_hash: `hash-of-${username}`,
  role: 'user',
  display_name: null,
  bio: null,
  created_at: new Date('2026-10-21T20:00:00.000Z'),
  last_seen_at: new Date('2026-10-30T20:00:00.000Z'),
  deleted_at: null,
  refresh_token: `token-of-${username}`,
  token_hash: `token-hash-of-${username}`,
  session_id: `session-of-${username}`,
});

const SECRET = /hash-of-|token-of-|token-hash-of-|session-of-/;

// Each fixture account's password, matched against its fake hash.
const passwordOf = (username: string) => `${username}-password!`;

const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 8, minute, 0));

describe('User profile endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let users: UserFixture[];
  let tables: Record<string, Row[]>;
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let rateLimitCalls: Array<{ method: string; path: string }>;
  let rateLimited: Set<string>;
  let revokedUsers: Set<string>;
  let connections: { opened: number; released: number; log: string[] };

  const server = () => app.getHttpServer();
  const get = (path: string, token?: string) => {
    const pending = request(server()).get(path);
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  };
  const patch = (body: unknown, token?: string) => {
    const pending = request(server())
      .patch('/users/me')
      .send(body as object);
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  };
  const del = (body: unknown, token?: string) => {
    const pending = request(server())
      .delete('/users/me')
      .send(body as object);
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  };
  const row = (id: string) => users.find((user) => user.id === id)!;
  const writes = () =>
    queryCalls.filter(({ sql }) => /^(UPDATE|DELETE|INSERT)/.test(sql));
  const owned = (table: string, column: string, id: string) =>
    tables[table].filter((entry) => entry[column] === id);

  beforeEach(async () => {
    queryCalls = [];
    rateLimitCalls = [];
    rateLimited = new Set();
    revokedUsers = new Set();
    connections = { opened: 0, released: 0, log: [] };
    users = [
      { ...account('user-a', 'sample_user'), display_name: 'Sam', bio: 'Hi' },
      { ...account('user-b', 'other_user'), role: 'moderator' },
      account('user-suspended', 'suspended_user'),
      account('user-banned', 'banned_user'),
    ];
    // user-b created community-b; user-a wrote post-a, which user-b replied
    // to, and holds a record in every table that references accounts.
    tables = {
      communities: [{ id: 'community-b', creator_id: 'user-b' }],
      community_subscriptions: [
        { user_id: 'user-a', community_id: 'community-b' },
        { user_id: 'user-b', community_id: 'community-b' },
      ],
      community_notification_preferences: [
        { user_id: 'user-a', community_id: 'community-b' },
        { user_id: 'user-b', community_id: 'community-b' },
      ],
      notifications: [
        { id: 'n-a', recipient_id: 'user-a', actor_id: 'user-b' },
        { id: 'n-b', recipient_id: 'user-b', actor_id: 'user-a' },
      ],
      posts: [
        {
          id: 'post-a',
          title: 'By A',
          content: 'Hello',
          type: 'text',
          author_id: 'user-a',
          community_id: 'community-b',
          created_at: at(1),
        },
      ],
      comments: [
        {
          id: 'comment-a',
          post_id: 'post-a',
          author_id: 'user-a',
          parent_id: null,
          content: 'First',
          created_at: at(2),
        },
        {
          id: 'reply-b',
          post_id: 'post-a',
          author_id: 'user-b',
          parent_id: 'comment-a',
          content: 'Reply by B',
          created_at: at(3),
        },
      ],
      votes: [{ user_id: 'user-a', target_type: 'post', target_id: 'post-a' }],
      user_reports: [{ id: 'report-1', reported_user_id: 'user-a' }],
      user_restrictions: [{ id: 'restriction-1', user_id: 'user-a' }],
      community_rule_acceptances: [
        { user_id: 'user-a', community_id: 'community-b' },
      ],
      community_moderators: [
        { user_id: 'user-a', community_id: 'community-b' },
      ],
    };

    // A users table that returns only the selected columns and applies an
    // UPDATE's assignments to the row its bound id names, plus the child
    // tables account deletion and the content listings touch.
    const execute = (sql: string, values: unknown[]) => {
      queryCalls.push({ sql, values });
      if (sql === LOCK_ACCOUNT_SQL) {
        const target = users.find((user) => user.id === values[0]);
        return Promise.resolve([
          target
            ? [
                {
                  id: target.id,
                  password_hash: target.password_hash,
                  deleted_at: target.deleted_at,
                },
              ]
            : [],
          [],
        ]);
      }
      if (sql === CREATED_COMMUNITY_SQL) {
        return Promise.resolve([
          owned('communities', 'creator_id', values[0] as string).map(
            ({ id }) => ({ id }),
          ),
          [],
        ]);
      }
      if (sql === ANONYMISE_ACCOUNT_SQL) {
        const [username, email, passwordHash, id] = values as string[];
        Object.assign(row(id), {
          username,
          email,
          password_hash: passwordHash,
          display_name: null,
          bio: null,
          last_seen_at: null,
          deleted_at: new Date('2026-11-02T12:00:00.000Z'),
        });
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      const remove = /^DELETE FROM (\w+) WHERE (\w+) = \?$/.exec(sql);
      if (remove) {
        const [, table, column] = remove;
        const before = tables[table].length;
        tables[table] = tables[table].filter(
          (entry) => entry[column] !== values[0],
        );
        return Promise.resolve([
          { affectedRows: before - tables[table].length },
          [],
        ]);
      }
      if (
        sql.startsWith(
          'SELECT id, title, content, type, author_id, community_id, created_at, pinned_at, pinned_by FROM posts WHERE EXISTS',
        )
      ) {
        return Promise.resolve([tables.posts, []]);
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM posts WHERE EXISTS')) {
        return Promise.resolve([[{ total: tables.posts.length }], []]);
      }
      if (sql.startsWith('SELECT id FROM posts WHERE id = ? AND EXISTS')) {
        return Promise.resolve([
          tables.posts.filter(({ id }) => id === values[0]),
          [],
        ]);
      }
      if (
        sql.startsWith(
          'SELECT id, post_id, author_id, parent_id, content, created_at FROM comments WHERE post_id = ?',
        )
      ) {
        return Promise.resolve([
          owned('comments', 'post_id', values[0] as string),
          [],
        ]);
      }
      const select =
        /^SELECT ([\w, ]+) FROM users WHERE (username|id) = \?( AND deleted_at IS NULL)? LIMIT 1$/.exec(
          sql,
        );
      if (select) {
        const columns = select[1].split(', ');
        const matches = users
          .filter(
            (user) =>
              user[select[2]] === values[0] &&
              (!select[3] || user.deleted_at === null),
          )
          .map((user) =>
            Object.fromEntries(columns.map((column) => [column, user[column]])),
          );
        return Promise.resolve([matches, []]);
      }
      const update = /^UPDATE users SET (.+) WHERE id = \?$/.exec(sql);
      if (update) {
        const columns = update[1].split(', ').map((set) => set.split(' ')[0]);
        const target = users.find((user) => user.id === values.at(-1));
        columns.forEach((column, index) => {
          if (target) target[column] = values[index] as string | null;
        });
        return Promise.resolve([{ affectedRows: target ? 1 : 0 }, []]);
      }
      throw new Error(`Unexpected SQL query: ${sql}`);
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute,
        getConnection: () => {
          connections.opened += 1;
          const step = (name: string) => () => {
            connections.log.push(name);
            return Promise.resolve();
          };
          return Promise.resolve({
            execute,
            beginTransaction: step('begin'),
            commit: step('commit'),
            rollback: step('rollback'),
            release: () => {
              connections.released += 1;
              connections.log.push('release');
            },
          });
        },
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({
        enforceApiRequest: (_ip: string, method: string, path: string) => {
          rateLimitCalls.push({ method, path });
          return Promise.resolve(
            rateLimited.has(`${method} ${path}`) ? 3600 : null,
          );
        },
      })
      // Token state comes from the table above; the password check follows
      // the fixture convention. auth.e2e-spec.ts runs the real AuthService.
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) => {
          const state = tokens[token];
          return Promise.resolve(
            state && !revokedUsers.has(state.userId)
              ? state
              : { kind: 'invalid' },
          );
        },
        passwordMatches: (password: string, storedHash: string) =>
          Promise.resolve(
            storedHash.startsWith('hash-of-') &&
              password === passwordOf(storedHash.slice('hash-of-'.length)),
          ),
        revokeAllSessions: (userId: string) => {
          connections.log.push(`revoke ${userId}`);
          revokedUsers.add(userId);
          return Promise.resolve();
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
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
  });

  describe('GET /users/:username', () => {
    it('returns the public fields and no account metadata', async () => {
      const response = await get('/users/sample_user').expect(200);

      expect(response.body).toEqual({
        username: 'sample_user',
        display_name: 'Sam',
        bio: 'Hi',
        created_at: '2026-10-21T20:00:00.000Z',
      });
      for (const field of [
        'id',
        'email',
        'role',
        'last_seen_at',
        'password',
        'password_hash',
      ]) {
        expect(response.body).not.toHaveProperty(field);
      }
      expect(JSON.stringify(response.body)).not.toMatch(SECRET);
      expect(queryCalls).toEqual([
        {
          sql: 'SELECT username, display_name, bio, created_at FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1',
          values: ['sample_user'],
        },
      ]);
    });

    it('returns 404 when the username does not exist', async () => {
      const response = await get('/users/unknown').expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        message: 'User not found',
        error: 'Not Found',
      });
    });

    it('rejects SQL-shaped and overlong usernames before querying the database', async () => {
      await get('/users/sample_user%27%20OR%201%3D1').expect(400);
      await get(`/users/${'a'.repeat(51)}`).expect(400);
      expect(queryCalls).toHaveLength(0);
    });
  });

  describe('GET /users/me', () => {
    it('is handled by the own-profile route, not :username', async () => {
      // The public route would answer 400 (too short) or look up "me".
      await get('/users/me').expect(401);
      expect(queryCalls).toHaveLength(0);
    });

    it('returns 401 for an invalid token', async () => {
      await get('/users/me', 'token-unknown').expect(401);
      expect(queryCalls).toHaveLength(0);
    });

    it("returns the caller's own account, and nothing private beyond it", async () => {
      const response = await get('/users/me', 'token-a').expect(200);

      expect(response.body).toEqual({
        id: 'user-a',
        username: 'sample_user',
        email: 'sample_user@example.com',
        display_name: 'Sam',
        bio: 'Hi',
        role: 'user',
        created_at: '2026-10-21T20:00:00.000Z',
      });
      expect(response.body).not.toHaveProperty('last_seen_at');
      expect(JSON.stringify(response.body)).not.toMatch(SECRET);
      expect(JSON.stringify(response.body)).not.toMatch(
        /password|token|session/i,
      );
    });

    it('returns each account its own record', async () => {
      const response = await get('/users/me', 'token-b').expect(200);
      expect(response.body).toMatchObject({
        id: 'user-b',
        email: 'other_user@example.com',
        role: 'moderator',
      });
    });

    it.each([
      ['token-suspended', 'user-suspended'],
      ['token-banned', 'user-banned'],
    ])('succeeds for a restricted account (%s)', async (token, id) => {
      const response = await get('/users/me', token).expect(200);
      expect(response.body).toMatchObject({ id });
    });
  });

  describe('PATCH /users/me', () => {
    it('returns 401 without a token and writes nothing', async () => {
      await patch({ bio: 'x' }).expect(401);
      await patch({ bio: 'x' }, 'token-unknown').expect(401);
      expect(writes()).toEqual([]);
    });

    it.each([
      ['token-suspended', 'suspension'],
      ['token-banned', 'ban'],
    ])(
      'returns 403 for a restricted account (%s) and writes nothing',
      async (token, type) => {
        const response = await patch({ bio: 'x' }, token).expect(403);
        expect(response.body).toMatchObject({ type });
        expect(writes()).toEqual([]);
      },
    );

    it('updates display_name alone and leaves bio unchanged', async () => {
      const response = await patch(
        { display_name: ' Samantha ' },
        'token-a',
      ).expect(200);

      expect(response.body).toMatchObject({
        id: 'user-a',
        display_name: 'Samantha',
        bio: 'Hi',
      });
      expect(row('user-a')).toMatchObject({
        display_name: 'Samantha',
        bio: 'Hi',
      });
      expect(writes()).toEqual([
        {
          sql: 'UPDATE users SET display_name = ? WHERE id = ?',
          values: ['Samantha', 'user-a'],
        },
      ]);
    });

    it('updates bio alone and leaves display_name unchanged', async () => {
      await patch({ bio: 'Grows tomatoes.\nAnd beans.' }, 'token-a').expect(
        200,
      );
      expect(row('user-a')).toMatchObject({
        display_name: 'Sam',
        bio: 'Grows tomatoes.\nAnd beans.',
      });
    });

    it('stores NULL for a field trimmed to empty', async () => {
      const response = await patch(
        { display_name: '   ', bio: '' },
        'token-a',
      ).expect(200);

      expect(response.body).toMatchObject({ display_name: null, bio: null });
      expect(row('user-a')).toMatchObject({ display_name: null, bio: null });
    });

    it('returns the full own-profile shape', async () => {
      const response = await patch({ bio: 'New' }, 'token-a').expect(200);
      expect(Object.keys(response.body as object).sort()).toEqual([
        'bio',
        'created_at',
        'display_name',
        'email',
        'id',
        'role',
        'username',
      ]);
      expect(JSON.stringify(response.body)).not.toMatch(SECRET);
    });

    it.each([
      [{}],
      [{ display_name: 'a'.repeat(51) }],
      [{ bio: 'b'.repeat(501) }],
      [{ display_name: 42 }],
      [{ bio: ['x'] }],
      [{ display_name: null }],
      [{ display_name: 'Sam\u0000' }],
      [{ bio: 'Hi\u0007' }],
    ])('returns 400 for %o and writes nothing', async (body) => {
      await patch(body, 'token-a').expect(400);
      expect(writes()).toEqual([]);
      expect(row('user-a')).toMatchObject({ display_name: 'Sam', bio: 'Hi' });
    });

    it.each([
      'username',
      'email',
      'role',
      'id',
      'created_at',
      'password_hash',
      'last_seen_at',
      'unexpected',
    ])(
      'returns 400 for a body containing %s and writes nothing',
      async (field) => {
        const response = await patch(
          { display_name: 'Sam', [field]: 'admin' },
          'token-a',
        ).expect(400);

        expect(response.body).toMatchObject({
          message: expect.arrayContaining([
            `property ${field} should not exist`,
          ]),
        });
        expect(writes()).toEqual([]);
        expect(row('user-a')).toMatchObject({
          username: 'sample_user',
          email: 'sample_user@example.com',
          role: 'user',
        });
      },
    );

    it("never touches another account's row", async () => {
      const before = structuredClone(row('user-b'));

      await patch({ id: 'user-b', bio: 'Pwned' }, 'token-a').expect(400);
      await patch({ bio: 'Mine' }, 'token-a').expect(200);

      expect(row('user-b')).toEqual(before);
      expect(row('user-a').bio).toBe('Mine');
      expect(writes().map(({ values }) => values.at(-1))).toEqual(['user-a']);
      const other = await get('/users/me', 'token-b').expect(200);
      expect(other.body).toMatchObject({ id: 'user-b', bio: null });
    });
  });

  describe('DELETE /users/me', () => {
    const correct = { password: passwordOf('sample_user') };

    it('anonymises the account and returns 204 with no body', async () => {
      const response = await del(correct, 'token-a').expect(204);

      expect(response.text).toBe('');
      expect(row('user-a')).toMatchObject({
        id: 'user-a',
        username: 'deleted_user-a',
        email: 'deleted_user-a@invalid',
        password_hash: 'deleted',
        display_name: null,
        bio: null,
        last_seen_at: null,
        deleted_at: expect.any(Date),
      });
      expect(connections.log).toEqual([
        'begin',
        'revoke user-a',
        'commit',
        'release',
      ]);
      expect(connections).toMatchObject({ opened: 1, released: 1 });
    });

    it('keeps content, votes, records about the account, and replies by others', async () => {
      await del(correct, 'token-a').expect(204);

      for (const [table, column] of [
        ['posts', 'author_id'],
        ['comments', 'author_id'],
        ['votes', 'user_id'],
        ['user_reports', 'reported_user_id'],
        ['user_restrictions', 'user_id'],
        ['community_rule_acceptances', 'user_id'],
        ['community_moderators', 'user_id'],
      ]) {
        expect([table, owned(table, column, 'user-a').length]).toEqual([
          table,
          1,
        ]);
      }
      expect(tables.comments.map(({ id }) => id)).toEqual([
        'comment-a',
        'reply-b',
      ]);
    });

    it("deletes only the account's own private state", async () => {
      await del(correct, 'token-a').expect(204);

      expect(owned('community_subscriptions', 'user_id', 'user-a')).toEqual([]);
      expect(
        owned('community_notification_preferences', 'user_id', 'user-a'),
      ).toEqual([]);
      expect(owned('notifications', 'recipient_id', 'user-a')).toEqual([]);
      // Other accounts' rows, including a notification A caused, survive.
      expect(
        owned('community_subscriptions', 'user_id', 'user-b'),
      ).toHaveLength(1);
      expect(owned('notifications', 'recipient_id', 'user-b')).toHaveLength(1);
      expect(row('user-b')).toMatchObject({ username: 'other_user' });
    });

    it("still lists the deleted account's post and its thread, under the placeholder", async () => {
      await del(correct, 'token-a').expect(204);

      const list = await get('/posts').expect(200);
      expect(list.body).toMatchObject({
        items: [{ id: 'post-a', author_id: 'user-a' }],
        total: 1,
      });
      const thread = await get('/posts/post-a/comments').expect(200);
      expect(JSON.stringify(thread.body)).toContain('reply-b');
    });

    it('takes the public profile down', async () => {
      await get('/users/sample_user').expect(200);
      await del(correct, 'token-a').expect(204);

      // The old name is gone, and the placeholder's UUID hyphens never pass
      // the username route pattern; UsersService also filters deleted_at.
      await get('/users/sample_user').expect(404);
      await get('/users/deleted_user-a').expect(400);
    });

    it('refuses every previously issued token afterwards; a repeat is 401', async () => {
      await del(correct, 'token-a').expect(204);

      await get('/users/me', 'token-a').expect(401);
      await del(correct, 'token-a').expect(401);
    });

    it('returns 401 for a wrong password and writes nothing', async () => {
      const response = await del(
        { password: passwordOf('other_user') },
        'token-a',
      ).expect(401);

      expect(response.body).toMatchObject({ message: 'Invalid credentials' });
      expect(writes()).toEqual([]);
      expect(row('user-a')).toMatchObject({ username: 'sample_user' });
      expect(connections.log).toEqual(['begin', 'rollback', 'release']);
      await get('/users/me', 'token-a').expect(200);
    });

    it.each([
      [{}],
      [{ password: '' }],
      [{ password: 'short' }],
      [{ password: 'a'.repeat(129) }],
      [{ password: 123456789012 }],
      [{ password: null }],
      [{ ...{ password: passwordOf('sample_user') }, user_id: 'user-b' }],
    ])('returns 400 for %o and writes nothing', async (body) => {
      await del(body, 'token-a').expect(400);
      expect(writes()).toEqual([]);
      expect(connections.opened).toBe(0);
    });

    it('returns 401 without a valid token', async () => {
      await del(correct).expect(401);
      await del(correct, 'token-unknown').expect(401);
      expect(connections.opened).toBe(0);
    });

    it.each([
      ['token-suspended', 'suspended_user', 'suspension'],
      ['token-banned', 'banned_user', 'ban'],
    ])(
      'returns 403 for a restricted account (%s) and deletes nothing',
      async (token, username, type) => {
        const response = await del(
          { password: passwordOf(username) },
          token,
        ).expect(403);

        expect(response.body).toMatchObject({ type });
        expect(connections.opened).toBe(0);
        expect(users.find((user) => user.username === username)).toBeDefined();
      },
    );

    it('returns 409 for a community creator and deletes nothing', async () => {
      const response = await del(
        { password: passwordOf('other_user') },
        'token-b',
      ).expect(409);

      expect(response.body).toMatchObject({
        statusCode: 409,
        message: COMMUNITY_CREATOR_MESSAGE,
      });
      expect(writes()).toEqual([]);
      expect(row('user-b')).toMatchObject({
        username: 'other_user',
        deleted_at: null,
      });
      expect(connections.log).toEqual(['begin', 'rollback', 'release']);
    });

    it('acts only on the token owner, whatever the body says', async () => {
      await del(correct, 'token-a').expect(204);

      expect(row('user-b')).toMatchObject({
        username: 'other_user',
        deleted_at: null,
      });
      expect(
        writes()
          .filter(({ sql }) => sql.startsWith('DELETE'))
          .every(({ values }) => values[0] === 'user-a'),
      ).toBe(true);
    });

    it('returns 429 with Retry-After from its dedicated bucket, deleting nothing', async () => {
      rateLimited.add('DELETE /users/me');

      const response = await del(correct, 'token-a').expect(429);

      expect(response.headers['retry-after']).toBe('3600');
      expect(connections.opened).toBe(0);
      expect(row('user-a')).toMatchObject({ deleted_at: null });
    });
  });

  it('keeps every route behind the global rate limiter', async () => {
    await get('/users/sample_user');
    await get('/users/me', 'token-a');
    await patch({ bio: 'x' }, 'token-a');
    await del({ password: passwordOf('sample_user') }, 'token-a');

    expect(rateLimitCalls).toEqual([
      { method: 'GET', path: '/users/sample_user' },
      { method: 'GET', path: '/users/me' },
      { method: 'PATCH', path: '/users/me' },
      { method: 'DELETE', path: '/users/me' },
    ]);
  });
});
