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

type UserFixture = Record<string, string | Date | null>;

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
  refresh_token: `token-of-${username}`,
  token_hash: `token-hash-of-${username}`,
  session_id: `session-of-${username}`,
});

const SECRET = /hash-of-|token-of-|token-hash-of-|session-of-/;

describe('User profile endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let users: UserFixture[];
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let rateLimitCalls: Array<{ method: string; path: string }>;

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
  const row = (id: string) => users.find((user) => user.id === id)!;
  const writes = () => queryCalls.filter(({ sql }) => sql.startsWith('UPDATE'));

  beforeEach(async () => {
    queryCalls = [];
    rateLimitCalls = [];
    users = [
      { ...account('user-a', 'sample_user'), display_name: 'Sam', bio: 'Hi' },
      { ...account('user-b', 'other_user'), role: 'moderator' },
      account('user-suspended', 'suspended_user'),
      account('user-banned', 'banned_user'),
    ];

    // A users table that returns only the selected columns and applies an
    // UPDATE's assignments to the row its bound id names.
    const execute = (sql: string, values: unknown[]) => {
      queryCalls.push({ sql, values });
      const select =
        /^SELECT ([\w, ]+) FROM users WHERE (username|id) = \? LIMIT 1$/.exec(
          sql,
        );
      if (select) {
        const columns = select[1].split(', ');
        const matches = users
          .filter((user) => user[select[2]] === values[0])
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
      .useValue({ execute })
      .overrideProvider(AuthRateLimitService)
      .useValue({
        enforceApiRequest: (_ip: string, method: string, path: string) => {
          rateLimitCalls.push({ method, path });
          return Promise.resolve(null);
        },
      })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(tokens[token] ?? { kind: 'invalid' }),
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
          sql: 'SELECT username, display_name, bio, created_at FROM users WHERE username = ? LIMIT 1',
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

  it('keeps every route behind the global rate limiter', async () => {
    await get('/users/sample_user');
    await get('/users/me', 'token-a');
    await patch({ bio: 'x' }, 'token-a');

    expect(rateLimitCalls).toEqual([
      { method: 'GET', path: '/users/sample_user' },
      { method: 'GET', path: '/users/me' },
      { method: 'PATCH', path: '/users/me' },
    ]);
  });
});
