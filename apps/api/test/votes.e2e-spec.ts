import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';

interface StoredVote {
  id: string;
  user_id: string;
  target_type: 'post' | 'comment';
  target_id: string;
  value: -1 | 1;
  created_at: Date;
}

describe('Vote endpoint (e2e)', () => {
  let app: INestApplication<App>;
  let votes: Map<string, StoredVote>;
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let commits: number;
  let rollbacks: number;

  beforeEach(async () => {
    votes = new Map();
    queryCalls = [];
    commits = 0;
    rollbacks = 0;
    const targets = {
      post: new Set(['post-1']),
      comment: new Set(['comment-1']),
    };
    const connection = {
      beginTransaction: async () => undefined,
      commit: async () => {
        commits += 1;
      },
      rollback: async () => {
        rollbacks += 1;
      },
      release: () => undefined,
      execute: async (sql: string, values: unknown[]) => {
        queryCalls.push({ sql, values });
        if (sql.includes('FOR UPDATE')) {
          const [targetId] = values as [string];
          const targetType = sql.includes('FROM posts') ? 'post' : 'comment';
          return [
            targets[targetType].has(targetId) ? [{ id: targetId }] : [],
            [],
          ];
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
          return [{ affectedRows: 1 }, []];
        }
        if (sql.startsWith('SELECT id, user_id, target_type')) {
          const [userId, targetType, targetId] = values as [
            string,
            StoredVote['target_type'],
            string,
          ];
          const stored = votes.get(`${userId}:${targetType}:${targetId}`);
          return [stored ? [stored] : [], []];
        }
        if (sql.startsWith('SELECT COALESCE(SUM(value)')) {
          const [targetType, targetId] = values as [
            StoredVote['target_type'],
            string,
          ];
          const score = [...votes.values()]
            .filter(
              (vote) =>
                vote.target_type === targetType && vote.target_id === targetId,
            )
            .reduce((total, vote) => total + vote.value, 0);
          return [[{ score }], []];
        }
        throw new Error(`Unexpected SQL query: ${sql}`);
      },
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({ getConnection: async () => connection })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessToken: async (token: string) =>
          token === 'valid-token'
            ? 'user-1'
            : token === 'another-token'
              ? 'user-2'
              : null,
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
    await app.close();
  });

  it('creates upvotes and downvotes and updates an existing vote direction', async () => {
    const upvote = await request(app.getHttpServer())
      .post('/votes')
      .set('Authorization', 'Bearer valid-token')
      .send({ target_type: 'post', target_id: 'post-1', value: 1 })
      .expect(201);

    expect(upvote.body).toMatchObject({
      user_id: 'user-1',
      target_type: 'post',
      target_id: 'post-1',
      value: 1,
      score: 1,
    });
    expect(Object.keys(upvote.body).sort()).toEqual([
      'created_at',
      'id',
      'score',
      'target_id',
      'target_type',
      'user_id',
      'value',
    ]);

    const secondUserVote = await request(app.getHttpServer())
      .post('/votes')
      .set('Authorization', 'Bearer another-token')
      .send({ target_type: 'post', target_id: 'post-1', value: 1 })
      .expect(201);
    expect(secondUserVote.body.score).toBe(2);

    const switchedVote = await request(app.getHttpServer())
      .post('/votes')
      .set('Authorization', 'Bearer valid-token')
      .send({ target_type: 'post', target_id: 'post-1', value: -1 })
      .expect(201);
    expect(switchedVote.body).toMatchObject({
      id: upvote.body.id,
      value: -1,
      score: 0,
    });
    expect(votes.size).toBe(2);

    await request(app.getHttpServer())
      .post('/votes')
      .set('Authorization', 'Bearer invalid-token')
      .send({ target_type: 'post', target_id: 'post-1', value: 1 })
      .expect(401);
    expect(votes.size).toBe(2);

    expect(commits).toBe(3);
    expect(rollbacks).toBe(0);
    expect(
      queryCalls
        .filter((call) => call.sql.startsWith('INSERT INTO votes'))
        .every((call) => call.sql.includes('ON DUPLICATE KEY UPDATE')),
    ).toBe(true);
  });

  it('includes other users in the recomputed score', async () => {
    await request(app.getHttpServer())
      .post('/votes')
      .set('Authorization', 'Bearer valid-token')
      .send({ target_type: 'comment', target_id: 'comment-1', value: 1 })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/votes')
      .set('Authorization', 'Bearer valid-token')
      .send({ target_type: 'comment', target_id: 'comment-1', value: -1 })
      .expect(201);
    expect(response.body.score).toBe(-1);
  });

  it('rejects missing auth and invalid vote types or values', async () => {
    const vote = { target_type: 'post', target_id: 'post-1', value: 1 };
    await request(app.getHttpServer()).post('/votes').send(vote).expect(401);

    for (const invalid of [
      { ...vote, target_type: 'user' },
      { ...vote, value: 0 },
      { ...vote, value: 2 },
      { ...vote, value: '1' },
      { ...vote, target_id: '' },
      { ...vote, target_id: "post-1' OR 1=1 --" },
    ]) {
      await request(app.getHttpServer())
        .post('/votes')
        .set('Authorization', 'Bearer valid-token')
        .send(invalid)
        .expect(400);
    }

    await request(app.getHttpServer())
      .post('/votes')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...vote, author_id: 'attacker' })
      .expect(400);
  });

  it('returns 404 for missing posts and comments', async () => {
    const missingPost = await request(app.getHttpServer())
      .post('/votes')
      .set('Authorization', 'Bearer valid-token')
      .send({ target_type: 'post', target_id: 'missing-post', value: 1 })
      .expect(404);
    expect(missingPost.body.message).toBe('Post not found');

    const missingComment = await request(app.getHttpServer())
      .post('/votes')
      .set('Authorization', 'Bearer valid-token')
      .send({ target_type: 'comment', target_id: 'missing-comment', value: -1 })
      .expect(404);
    expect(missingComment.body.message).toBe('Comment not found');

    expect(
      queryCalls.some((call) => call.sql.startsWith('INSERT INTO votes')),
    ).toBe(false);
    expect(rollbacks).toBe(2);
  });
});
