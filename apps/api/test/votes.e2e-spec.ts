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

describe('Vote endpoint (e2e)', () => {
  let app: INestApplication<App>;
  let votes: Map<string, StoredVote>;
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let commits: number;
  let rollbacks: number;
  let releases: number;
  let rules: RulesStore;

  beforeEach(async () => {
    votes = new Map();
    queryCalls = [];
    commits = 0;
    rollbacks = 0;
    releases = 0;
    // No community has published rules unless a test publishes some.
    rules = createRulesStore({
      'community-1': { name: 'general', creator_id: 'creator-1' },
      'community-2': { name: 'orchards', creator_id: 'creator-2' },
    });
    // Each target's community. comment-1 sits on a post in community-2, so a
    // comment vote is gated on the community reached through its post.
    const targets = {
      post: new Map([['post-1', 'community-1']]),
      comment: new Map([['comment-1', 'community-2']]),
    };
    const connection = {
      beginTransaction: async () => undefined,
      commit: async () => {
        commits += 1;
      },
      rollback: async () => {
        rollbacks += 1;
      },
      release: () => {
        releases += 1;
      },
      execute: async (sql: string, values: unknown[]) => {
        queryCalls.push({ sql, values });
        const ruleAnswer = rules.handle(sql, values);
        if (ruleAnswer) {
          return ruleAnswer;
        }
        if (sql.includes('FOR UPDATE')) {
          const [targetId] = values as [string];
          const targetType = sql.includes('FROM posts') ? 'post' : 'comment';
          const communityId = targets[targetType].get(targetId);
          return [
            communityId ? [{ id: targetId, community_id: communityId }] : [],
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
      .useValue({
        getConnection: () => Promise.resolve(connection),
        // Only the rule acceptance routes use the pool directly.
        execute: (sql: string, values: unknown[]) =>
          rules.handle(sql, values) ??
          Promise.reject(new Error(`Unexpected SQL query: ${sql}`)),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) => {
          const userId = {
            'valid-token': 'user-1',
            'another-token': 'user-2',
            'creator-token': 'creator-2',
          }[token];
          return Promise.resolve(
            userId ? { kind: 'valid', userId } : { kind: 'invalid' },
          );
        },
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

  describe('rule acceptance', () => {
    const vote = (token: string, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/votes')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    const postVote = { target_type: 'post', target_id: 'post-1', value: 1 };
    const commentVote = {
      target_type: 'comment',
      target_id: 'comment-1',
      value: 1,
    };

    it('refuses a post vote until the rules are accepted, then records it', async () => {
      rules.publish('community-1');

      const refused = await vote('valid-token', postVote).expect(403);
      expect(refused.body).toEqual({
        reason: 'community_rules_not_accepted',
        community: 'general',
        current_version: 1,
      });
      expect(JSON.stringify(refused.body)).not.toMatch(
        /user-1|community-1|rules-v|creator/,
      );
      expect(votes.size).toBe(0);
      expect({ commits, rollbacks, releases }).toEqual({
        commits: 0,
        rollbacks: 1,
        releases: 1,
      });

      await request(app.getHttpServer())
        .post('/communities/general/rules/acceptance')
        .set('Authorization', 'Bearer valid-token')
        .send({ version: 1 })
        .expect(201);
      await vote('valid-token', postVote).expect(201);
      expect(votes.size).toBe(1);
    });

    it('gates a comment vote on the community of the comment’s post', async () => {
      rules.publish('community-2');

      await vote('valid-token', postVote).expect(201);
      const refused = await vote('valid-token', commentVote).expect(403);
      expect(refused.body).toMatchObject({ community: 'orchards' });
      expect(votes.size).toBe(1);

      await vote('creator-token', commentVote).expect(201);
    });

    it('returns 404, not 403, for an unknown target', async () => {
      rules.publish('community-1');
      rules.publish('community-2');

      await vote('valid-token', { ...postVote, target_id: 'missing' }).expect(
        404,
      );
      await vote('valid-token', {
        ...commentVote,
        target_id: 'missing',
      }).expect(404);
      expect(
        rules.statements.some((sql) =>
          sql.includes('community_rule_acceptances'),
        ),
      ).toBe(false);
    });
  });
});
