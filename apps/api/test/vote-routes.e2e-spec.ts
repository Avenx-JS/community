import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import {
  createRulesStore,
  type RulesStore,
} from './fakes/community-rules-store';

interface StoredVote {
  id: string;
  user_id: string;
  target_type: 'post' | 'comment';
  target_id: string;
  value: -1 | 1;
  created_at: Date;
}

type Target = 'posts' | 'comments';

// PUT, DELETE and GET /posts/:id/vote and /comments/:id/vote. A stubbed
// MYSQL_POOL in the style of votes.e2e-spec.ts (left unchanged), extended
// with the withdrawal, the caller's-own-vote read and the non-locking target
// lookup. Connections are counted so every path is shown to release.
describe('Vote routes on posts and comments (e2e)', () => {
  let app: INestApplication<App>;
  let votes: Map<string, StoredVote>;
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let acquired: number;
  let released: number;
  let rules: RulesStore;
  let deletedCommunities: Set<string>;

  const tokens: Record<string, string> = {
    'user-1-token': 'user-1',
    'user-2-token': 'user-2',
  };

  beforeEach(async () => {
    votes = new Map();
    queryCalls = [];
    acquired = 0;
    released = 0;
    deletedCommunities = new Set();
    rules = createRulesStore({
      'community-1': { name: 'general', creator_id: 'creator-1' },
      'community-2': { name: 'orchards', creator_id: 'creator-2' },
    });
    // comment-1 is on a post in community-2: its community is reached
    // through comments → posts.
    const targets = {
      post: new Map([['post-1', 'community-1']]),
      comment: new Map([['comment-1', 'community-2']]),
    };
    const scoreOf = (targetType: string, targetId: string) =>
      [...votes.values()]
        .filter(
          (vote) =>
            vote.target_type === targetType && vote.target_id === targetId,
        )
        .reduce((total, vote) => total + vote.value, 0);

    const execute = (sql: string, values: unknown[]) => {
      queryCalls.push({ sql, values });
      const ruleAnswer = rules.handle(sql, values);
      if (ruleAnswer) {
        return ruleAnswer;
      }
      if (
        sql.startsWith(
          'SELECT id, community_id, removed_at IS NOT NULL AS removed FROM posts',
        ) ||
        sql.startsWith('SELECT comments.id, posts.community_id')
      ) {
        const [targetId] = values as [string];
        const targetType = sql.includes('FROM posts WHERE')
          ? 'post'
          : 'comment';
        const communityId = targets[targetType].get(targetId);
        const hidden =
          communityId !== undefined &&
          sql.includes('deleted_at IS NULL') &&
          deletedCommunities.has(communityId);
        return Promise.resolve([
          communityId && !hidden
            ? [{ id: targetId, community_id: communityId }]
            : [],
          [],
        ]);
      }
      if (sql.startsWith('INSERT INTO votes')) {
        const [id, userId, targetType, targetId, value] = values as [
          string,
          string,
          StoredVote['target_type'],
          string,
          StoredVote['value'],
        ];
        const key = `${userId}:${targetType}:${targetId}`;
        const current = votes.get(key);
        votes.set(key, {
          id: current?.id ?? id,
          user_id: userId,
          target_type: targetType,
          target_id: targetId,
          value,
          created_at: current?.created_at ?? new Date('2026-10-22T08:00:00Z'),
        });
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if (sql.startsWith('DELETE FROM votes')) {
        const [userId, targetType, targetId] = values as string[];
        const existed = votes.delete(`${userId}:${targetType}:${targetId}`);
        return Promise.resolve([{ affectedRows: existed ? 1 : 0 }, []]);
      }
      if (sql.startsWith('SELECT id, user_id, target_type')) {
        const [userId, targetType, targetId] = values as string[];
        const stored = votes.get(`${userId}:${targetType}:${targetId}`);
        return Promise.resolve([stored ? [stored] : [], []]);
      }
      if (sql.startsWith('SELECT value FROM votes')) {
        const [userId, targetType, targetId] = values as string[];
        const stored = votes.get(`${userId}:${targetType}:${targetId}`);
        return Promise.resolve([stored ? [{ value: stored.value }] : [], []]);
      }
      if (sql.startsWith('SELECT COALESCE(SUM(value)')) {
        const [targetType, targetId] = values as string[];
        return Promise.resolve([
          [{ score: scoreOf(targetType, targetId) }],
          [],
        ]);
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute,
        getConnection: () => {
          acquired += 1;
          return Promise.resolve({
            execute,
            beginTransaction: () => Promise.resolve(),
            commit: () => Promise.resolve(),
            rollback: () => Promise.resolve(),
            release: () => {
              released += 1;
            },
          });
        },
      })
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
    expect(released).toBe(acquired);
    await app.close();
  });

  const as = (token?: string) => {
    const authed = (call: request.Test) =>
      token ? call.set('Authorization', `Bearer ${token}`) : call;
    const server = () => request(app.getHttpServer());
    return {
      put: (path: string, body: object) =>
        authed(server().put(path)).send(body),
      delete: (path: string) => authed(server().delete(path)),
      get: (path: string) => authed(server().get(path)),
      post: (path: string, body: object) =>
        authed(server().post(path)).send(body),
    };
  };
  const user1 = as('user-1-token');
  const user2 = as('user-2-token');
  const stored = () => [...votes.values()];

  describe.each([
    ['posts', 'post-1', 'post', 'community-1', 'general', 'Post not found'],
    [
      'comments',
      'comment-1',
      'comment',
      'community-2',
      'orchards',
      'Comment not found',
    ],
  ] as const)(
    '/%s/:id/vote',
    (resource: Target, id, targetType, communityId, communityName, missing) => {
      const path = `/${resource}/${id}/vote`;

      it('votes, changes, repeats, withdraws and re-votes with the score each time', async () => {
        const first = await user1.put(path, { value: 1 }).expect(200);
        expect(first.body).toEqual({
          id: expect.any(String) as unknown,
          user_id: 'user-1',
          target_type: targetType,
          target_id: id,
          value: 1,
          created_at: '2026-10-22T08:00:00.000Z',
          score: 1,
        });
        expect(stored()).toHaveLength(1);

        // Idempotent: the same PUT leaves one row and the same score.
        const again = await user1.put(path, { value: 1 }).expect(200);
        expect(again.body).toEqual(first.body);
        expect(stored()).toHaveLength(1);

        // Changing value updates the row in place.
        const flipped = await user1.put(path, { value: -1 }).expect(200);
        expect(flipped.body).toMatchObject({
          id: (first.body as { id: string }).id,
          value: -1,
          score: -1,
        });
        expect(stored()).toHaveLength(1);

        await user2.put(path, { value: 1 }).expect(200);
        await user1.get(path).expect(200, { value: -1, score: 0 });

        const withdrawn = await user1.delete(path).expect(200);
        expect(withdrawn.body).toEqual({ score: 1 });
        expect(stored().map((vote) => vote.user_id)).toEqual(['user-2']);

        // Idempotent no-op: nothing to remove, the current score back.
        await user1.delete(path).expect(200, { score: 1 });
        expect(stored()).toHaveLength(1);
        await user1.get(path).expect(200, { value: null, score: 1 });

        const revote = await user1.put(path, { value: 1 }).expect(200);
        expect(revote.body).toMatchObject({ value: 1, score: 2 });
      });

      it('never reveals another account’s vote', async () => {
        await user2.put(path, { value: -1 }).expect(200);
        await user1.get(path).expect(200, { value: null, score: -1 });

        await user1.put(path, { value: 1 }).expect(200);
        await user1.get(path).expect(200, { value: 1, score: 0 });
        await user2.get(path).expect(200, { value: -1, score: 0 });

        const reads = queryCalls.filter(({ sql }) =>
          sql.startsWith('SELECT value FROM votes'),
        );
        expect(reads.map(({ values }) => values[0])).toEqual([
          'user-1',
          'user-1',
          'user-2',
        ]);
      });

      it('gates PUT on the community rules, and not DELETE', async () => {
        await user1.put(path, { value: 1 }).expect(200);
        rules.publish(communityId);

        const refused = await user1.put(path, { value: -1 }).expect(403);
        expect(refused.body).toEqual({
          reason: 'community_rules_not_accepted',
          community: communityName,
          current_version: 1,
        });
        expect(stored()[0].value).toBe(1);

        // Withdrawal removes participation: allowed without accepting.
        await user1.delete(path).expect(200, { score: 0 });
        expect(stored()).toHaveLength(0);
        await user1.get(path).expect(200, { value: null, score: 0 });
      });

      it.each([
        [{}, 'missing value'],
        [{ value: 0 }, 'value 0'],
        [{ value: 2 }, 'value 2'],
        [{ value: '1' }, 'a string'],
        [{ value: 1, target_type: 'post' }, 'an unknown property'],
        [{ value: 1, user_id: 'user-2' }, 'a user_id'],
      ] as [object, string][])(
        'answers %o (%s) with 400 and writes nothing',
        async (body) => {
          await user1.put(path, body).expect(400);
          expect(stored()).toHaveLength(0);
          expect(acquired).toBe(0);
        },
      );

      it('answers 401 without a token on every method', async () => {
        await as().put(path, { value: 1 }).expect(401);
        await as().delete(path).expect(401);
        await as().get(path).expect(401);
        expect(acquired).toBe(0);
      });

      it('answers 400 for a malformed id and 404 for an unknown one on every method', async () => {
        const malformed = `/${resource}/x%27%20OR%201%3D1/vote`;
        await user1.put(malformed, { value: 1 }).expect(400);
        await user1.delete(malformed).expect(400);
        await user1.get(malformed).expect(400);

        const unknown = `/${resource}/missing/vote`;
        for (const response of [
          await user1.put(unknown, { value: 1 }).expect(404),
          await user1.delete(unknown).expect(404),
          await user1.get(unknown).expect(404),
        ]) {
          expect((response.body as { message: string }).message).toBe(missing);
        }
      });

      it('answers 404 on every method once the community is deleted', async () => {
        await user1.put(path, { value: 1 }).expect(200);
        deletedCommunities.add(communityId);
        await user1.put(path, { value: -1 }).expect(404);
        await user1.delete(path).expect(404);
        await user1.get(path).expect(404);
        expect(stored()).toHaveLength(1);
      });

      it('locks the target for PUT and DELETE, and reads it without a lock for GET', async () => {
        await user1.put(path, { value: 1 }).expect(200);
        await user1.delete(path).expect(200);
        await user1.get(path).expect(200);
        const lookups = queryCalls.filter(({ sql }) =>
          /^SELECT (id, community_id, removed_at IS NOT NULL AS removed FROM posts|comments\.id, posts\.community_id)/.test(
            sql,
          ),
        );
        expect(lookups.map(({ sql }) => sql.includes('FOR UPDATE'))).toEqual([
          true,
          true,
          false,
        ]);
        // GET takes no transaction connection.
        expect(acquired).toBe(2);
      });
    },
  );

  it('resolves a comment vote’s community through its post for the rule gate', async () => {
    rules.publish('community-2');
    await user1.put('/comments/comment-1/vote', { value: 1 }).expect(403);
    await user1.put('/posts/post-1/vote', { value: 1 }).expect(200);
  });

  it('produces the same row and score through PUT /posts/:id/vote and the deprecated POST /votes', async () => {
    const viaPost = await user1
      .post('/votes', { target_type: 'post', target_id: 'post-1', value: 1 })
      .expect(201);
    const rowAfterPost = { ...stored()[0] };

    const viaPut = await user1
      .put('/posts/post-1/vote', { value: 1 })
      .expect(200);
    expect(viaPut.body).toEqual(viaPost.body);
    expect(stored()).toEqual([rowAfterPost]);

    await user1
      .post('/votes', { target_type: 'post', target_id: 'post-1', value: -1 })
      .expect(201);
    const flipped = await user1.get('/posts/post-1/vote').expect(200);
    expect(flipped.body).toEqual({ value: -1, score: -1 });
    expect(stored()).toHaveLength(1);
  });
});
