import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { USER_ID_BY_USERNAME_SQL } from '../src/users/user-activity.service';
import {
  BLOCK_STATE_SQL,
  BLOCK_USER_SQL,
  BLOCKED_USERS_COUNT_SQL,
  BLOCKED_USERS_SQL,
  LOCK_BLOCKED_SQL,
  LOCK_BLOCKER_SQL,
  UNBLOCK_USER_SQL,
} from '../src/users/user-blocks.service';

interface FakeUser {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  created_at: Date;
  deleted_at: Date | null;
  // Planted on every row: no response may ever carry them.
  email: string;
  password_hash: string;
}

interface StoredBlock {
  blocker_id: string;
  blocked_id: string;
  created_at: Date;
}

const CAP = 3;

// GET /users/me/blocked and POST and DELETE /users/me/blocked/:username, over a
// stubbed MYSQL_POOL that evaluates the service's statements on in-memory
// tables. The real-server behaviour (locks, plans, cascades) is in
// src/database/user-blocks.mysql.spec.ts.
describe('User blocks (e2e)', () => {
  let app: INestApplication<App>;
  let users: FakeUser[];
  let blocks: StoredBlock[];
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let clock: number;

  const user = (id: string, username: string): FakeUser => ({
    id,
    username,
    display_name: `${username} display`,
    bio: null,
    created_at: new Date('2026-10-01T08:00:00.000Z'),
    deleted_at: null,
    email: 'leak@example.test',
    password_hash: 'argon2id$leak',
  });

  beforeEach(async () => {
    process.env.USER_BLOCKS_MAX = String(CAP);
    users = [
      user('user-a', 'alice'),
      user('user-b', 'bob'),
      user('user-c', 'carol'),
      user('user-d', 'dave'),
      user('user-e', 'erin'),
      user('user-mod', 'moderator_user'),
      { ...user('user-gone', 'gone_user'), deleted_at: new Date() },
    ];
    blocks = [];
    queryCalls = [];
    clock = Date.parse('2026-11-01T08:00:00.000Z');

    const listed = (blockerId: string) =>
      blocks
        .filter((block) => block.blocker_id === blockerId)
        .map((block) => ({
          block,
          user: users.find((entry) => entry.id === block.blocked_id)!,
        }))
        .filter(({ user }) => !user.deleted_at);

    const execute = (sql: string, values: unknown[]) => {
      queryCalls.push({ sql, values });
      if (sql === USER_ID_BY_USERNAME_SQL) {
        return Promise.resolve([
          users
            .filter(
              (entry) => entry.username === values[0] && !entry.deleted_at,
            )
            .map(({ id }) => ({ id })),
          [],
        ]);
      }
      if (sql === LOCK_BLOCKER_SQL || sql === LOCK_BLOCKED_SQL) {
        return Promise.resolve([
          users
            .filter((entry) => entry.id === values[0])
            .map(({ deleted_at }) => ({ deleted_at })),
          [],
        ]);
      }
      if (sql === BLOCK_STATE_SQL) {
        const [blockedId, blockerId] = values as string[];
        const own = blocks.filter((block) => block.blocker_id === blockerId);
        return Promise.resolve([
          [
            {
              total: own.length,
              already_blocked: own.filter((b) => b.blocked_id === blockedId)
                .length,
            },
          ],
          [],
        ]);
      }
      if (sql === BLOCK_USER_SQL) {
        const [blockerId, blockedId] = values as string[];
        if (
          !blocks.some(
            (b) => b.blocker_id === blockerId && b.blocked_id === blockedId,
          )
        ) {
          blocks.push({
            blocker_id: blockerId,
            blocked_id: blockedId,
            created_at: new Date(clock),
          });
        }
        clock += 60_000;
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if (sql === UNBLOCK_USER_SQL) {
        const [blockerId, blockedId] = values as string[];
        const before = blocks.length;
        blocks = blocks.filter(
          (b) => !(b.blocker_id === blockerId && b.blocked_id === blockedId),
        );
        return Promise.resolve([{ affectedRows: before - blocks.length }, []]);
      }
      if (sql === BLOCKED_USERS_SQL) {
        const [blockerId, limit, offset] = values as [string, number, number];
        return Promise.resolve([
          listed(blockerId)
            .sort(
              (left, right) =>
                right.block.created_at.getTime() -
                  left.block.created_at.getTime() ||
                right.block.blocked_id.localeCompare(left.block.blocked_id),
            )
            .slice(offset, offset + limit)
            .map(({ block, user }) => ({
              ...user,
              blocked_at: block.created_at,
            })),
          [],
        ]);
      }
      if (sql === BLOCKED_USERS_COUNT_SQL) {
        return Promise.resolve([
          [{ total: listed(values[0] as string).length }],
          [],
        ]);
      }
      // GET /users/:username, for what the blocked user can see.
      if (sql.startsWith('SELECT username, display_name, bio, created_at')) {
        return Promise.resolve([
          users.filter(
            (entry) => entry.username === values[0] && !entry.deleted_at,
          ),
          [],
        ]);
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };

    const connection = {
      execute,
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
    };

    const tokens: Record<string, string> = {
      'token-a': 'user-a',
      'token-b': 'user-b',
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({ execute, getConnection: () => Promise.resolve(connection) })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            token in tokens
              ? { kind: 'valid', userId: tokens[token] }
              : { kind: 'invalid' },
          ),
      })
      .compile();

    app = moduleFixture.createNestApplication();
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
    delete process.env.USER_BLOCKS_MAX;
    await app.close();
  });

  const as = (token?: string) => {
    const server = () => request(app.getHttpServer());
    const auth = (call: request.Test) =>
      token ? call.set('Authorization', `Bearer ${token}`) : call;
    return {
      block: (name: string) => auth(server().post(`/users/me/blocked/${name}`)),
      unblock: (name: string) =>
        auth(server().delete(`/users/me/blocked/${name}`)),
      list: (query = '') => auth(server().get(`/users/me/blocked${query}`)),
      get: (path: string) => auth(server().get(path)),
    };
  };
  const userA = as('token-a');
  const userB = as('token-b');
  type Page = {
    items: { username: string; display_name: string; blocked_at: string }[];
    page: number;
    limit: number;
    total: number;
  };
  const listNames = async (token = 'token-a', query = '') =>
    ((await as(token).list(query).expect(200)).body as Page).items.map(
      (item) => item.username,
    );

  describe('POST /users/me/blocked/:username', () => {
    it('answers 204 with no body and creates one row bound to the caller', async () => {
      await userA.block('bob').expect(204, '');
      expect(blocks).toEqual([
        expect.objectContaining({
          blocker_id: 'user-a',
          blocked_id: 'user-b',
        }),
      ]);
    });

    it('is idempotent: a repeat leaves one row and keeps its created_at', async () => {
      await userA.block('bob').expect(204);
      const first = blocks[0].created_at;
      await userA.block('bob').expect(204);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].created_at).toEqual(first);
    });

    it('answers 400 for your own account, writing nothing', async () => {
      const response = await userA.block('alice').expect(400);
      expect((response.body as { message: string }).message).toBe(
        'You cannot block yourself',
      );
      expect(blocks).toEqual([]);
    });

    it.each([
      ['nobody_here', 'an unknown username'],
      ['gone_user', 'a deleted account'],
    ])('answers %s (%s) with 404, writing nothing', async (name) => {
      await userA.block(name).expect(404);
      expect(blocks).toEqual([]);
    });

    it.each(['x%27%20OR%201%3D1', 'ab', 'deleted_a1b2-c3d4'])(
      'answers the malformed username %s with 400',
      async (name) => {
        await userA.block(name).expect(400);
        expect(blocks).toEqual([]);
      },
    );

    it('answers 401 without a valid token', async () => {
      await as().block('bob').expect(401);
      await as('not-a-token').block('bob').expect(401);
      expect(blocks).toEqual([]);
    });

    it('takes the blocker from the token, whatever the request says', async () => {
      await userA
        .block('bob')
        .query({ blocker_id: 'user-b' })
        .send({ blocker_id: 'user-b' })
        .expect(204);
      expect(blocks[0].blocker_id).toBe('user-a');
    });

    it('allows blocking a moderator: the row is recorded and changes nothing else', async () => {
      await userA.block('moderator_user').expect(204);
      expect(await listNames()).toEqual(['moderator_user']);
    });

    describe('at USER_BLOCKS_MAX', () => {
      beforeEach(async () => {
        await userA.block('bob').expect(204);
        await userA.block('carol').expect(204);
        await userA.block('dave').expect(204);
      });

      it('answers 409 and writes nothing', async () => {
        const response = await userA.block('erin').expect(409);
        expect((response.body as { message: string }).message).toBe(
          `You can block at most ${CAP} accounts`,
        );
        expect(blocks).toHaveLength(CAP);
      });

      it('still accepts a repeat block, which adds no row', async () => {
        await userA.block('bob').expect(204);
        expect(blocks).toHaveLength(CAP);
      });

      it('frees a slot on unblock, and counts per account', async () => {
        await userB.block('erin').expect(204);
        await userA.unblock('bob').expect(204);
        await userA.block('erin').expect(204);
        expect(await listNames()).toEqual(['erin', 'dave', 'carol']);
      });
    });
  });

  describe('DELETE /users/me/blocked/:username', () => {
    it('removes the caller’s row only, with 204', async () => {
      await userA.block('carol').expect(204);
      await userB.block('carol').expect(204);
      await userA.unblock('carol').expect(204, '');
      expect(blocks.map((block) => block.blocker_id)).toEqual(['user-b']);
    });

    it('is idempotent: removing a block that does not exist is 204', async () => {
      await userA.unblock('bob').expect(204);
      await userA.block('bob').expect(204);
      await userA.unblock('bob').expect(204);
      await userA.unblock('bob').expect(204);
      expect(blocks).toEqual([]);
    });

    it('answers 404 for an unknown user, 400 for a malformed one, 401 without a token', async () => {
      await userA.unblock('nobody_here').expect(404);
      await userA.unblock('x%27%20OR%201%3D1').expect(400);
      await as().unblock('bob').expect(401);
    });
  });

  describe('GET /users/me/blocked', () => {
    it('lists newest first, with the envelope and only the documented fields', async () => {
      await userA.block('carol').expect(204);
      await userA.block('bob').expect(204);

      const body = (await userA.list().expect(200)).body as Page;
      expect(body).toEqual({
        items: [
          {
            username: 'bob',
            display_name: 'bob display',
            blocked_at: '2026-11-01T08:01:00.000Z',
          },
          {
            username: 'carol',
            display_name: 'carol display',
            blocked_at: '2026-11-01T08:00:00.000Z',
          },
        ],
        page: 1,
        limit: 20,
        total: 2,
      });
    });

    it('breaks a created_at tie by blocked_id, descending', async () => {
      const tied = new Date('2026-11-01T08:00:00.000Z');
      blocks = ['user-b', 'user-d', 'user-c'].map((blocked_id) => ({
        blocker_id: 'user-a',
        blocked_id,
        created_at: tied,
      }));
      expect(await listNames()).toEqual(['dave', 'carol', 'bob']);
    });

    it('never returns another account’s list', async () => {
      await userA.block('carol').expect(204);
      await userB.block('dave').expect(204);
      expect(await listNames('token-a')).toEqual(['carol']);
      expect(await listNames('token-b')).toEqual(['dave']);
      // Asking for someone else's list is not expressible.
      await userA.list('?user_id=user-b').expect(400);
      await userA.list('?username=bob').expect(400);
    });

    it('answers an account without blocks with an empty page', async () => {
      const body = (await userA.list().expect(200)).body as Page;
      expect(body).toEqual({ items: [], page: 1, limit: 20, total: 0 });
    });

    it.each([
      '?page=0',
      '?page=10001',
      '?limit=0',
      '?limit=101',
      '?limit=ten',
      '?unexpected=1',
    ])('rejects %s with 400', async (query) => {
      await userA.list(query).expect(400);
    });

    it('requires a token', async () => {
      await as().list().expect(401);
    });

    it('pages, with the total unchanged', async () => {
      await userA.block('bob').expect(204);
      await userA.block('carol').expect(204);
      await userA.block('dave').expect(204);
      const second = (await userA.list('?limit=2&page=2').expect(200))
        .body as Page;
      expect(second).toMatchObject({ page: 2, limit: 2, total: 3 });
      expect(second.items.map((item) => item.username)).toEqual(['bob']);
    });

    it('returns the identifier the write routes accept', async () => {
      await userA.block('bob').expect(204);
      const [listed] = await listNames();
      await userA.unblock(listed).expect(204);
      expect(blocks).toEqual([]);
      await userA.block(listed).expect(204);
      expect(blocks).toHaveLength(1);
    });

    it('omits an account deleted after it was blocked, counting the same way', async () => {
      await userA.block('bob').expect(204);
      await userA.block('carol').expect(204);
      users.find((entry) => entry.id === 'user-b')!.deleted_at = new Date();
      const body = (await userA.list().expect(200)).body as Page;
      expect(body.total).toBe(1);
      expect(body.items.map((item) => item.username)).toEqual(['carol']);
      await userA.unblock('bob').expect(404);
    });
  });

  it('round-trips block, list, re-block, unblock, re-unblock', async () => {
    await userA.block('bob').expect(204);
    expect(await listNames()).toEqual(['bob']);
    await userA.block('bob').expect(204);
    expect(await listNames()).toEqual(['bob']);
    await userA.unblock('bob').expect(204);
    expect(await listNames()).toEqual([]);
    await userA.unblock('bob').expect(204);
    expect(await listNames()).toEqual([]);
  });

  describe('privacy', () => {
    it('never serialises an email, password hash, user id, token or session', async () => {
      await userA.block('bob').expect(204);
      const text = JSON.stringify((await userA.list().expect(200)).body);
      expect(text).not.toMatch(
        /email|password_hash|leak|user-[a-z]|token|session|blocker_id|blocked_id/,
      );
    });

    it('shows the blocked user nothing: their view of the blocker is unchanged', async () => {
      const before = (await userB.get('/users/alice').expect(200))
        .body as unknown;
      await userA.block('bob').expect(204);
      const after = (await userB.get('/users/alice').expect(200))
        .body as unknown;
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).not.toMatch(/block/i);
      // The blocked user's own list says nothing about who blocked them.
      expect(await listNames('token-b')).toEqual([]);
    });

    it('writes no notification and no audit entry, touching only the block tables', async () => {
      await userA.block('bob').expect(204);
      await userA.unblock('bob').expect(204);
      const writes = queryCalls
        .map(({ sql }) => sql)
        .filter((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql));
      expect(new Set(writes)).toEqual(
        new Set([BLOCK_USER_SQL, UNBLOCK_USER_SQL]),
      );
    });

    it('exposes no route to another user’s list or to who blocked the caller', async () => {
      await userB.get('/users/alice/blocked').expect(404);
      await userB.get('/users/me/blocked-by').expect(404);
      await userB.get('/users/me/blocked/alice').expect(404);
    });
  });
});
