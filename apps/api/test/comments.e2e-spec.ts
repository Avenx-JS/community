import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';

interface TestComment {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  content: string;
  created_at: Date;
}

describe('Comment endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let comments: TestComment[];
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  const postIds = ['post-1', 'post-2'];
  const communityCreators = new Map([['community-1', 'creator-1']]);
  const moderatorAssignments = new Set(['community-1:user-mod']);

  beforeEach(async () => {
    comments = [
      {
        id: 'root-1',
        post_id: 'post-1',
        author_id: 'user-1',
        parent_id: null,
        content: 'Root comment',
        created_at: new Date('2026-10-22T08:00:00.000Z'),
      },
      {
        id: 'reply-1',
        post_id: 'post-1',
        author_id: 'user-2',
        parent_id: 'root-1',
        content: 'Reply',
        created_at: new Date('2026-10-22T08:01:00.000Z'),
      },
      {
        id: 'nested-reply',
        post_id: 'post-1',
        author_id: 'user-1',
        parent_id: 'reply-1',
        content: 'Nested reply',
        created_at: new Date('2026-10-22T08:02:00.000Z'),
      },
      {
        id: 'root-2',
        post_id: 'post-1',
        author_id: 'user-3',
        parent_id: null,
        content: 'Second root',
        created_at: new Date('2026-10-22T08:00:00.000Z'),
      },
      {
        id: 'other-post-comment',
        post_id: 'post-2',
        author_id: 'user-2',
        parent_id: null,
        content: 'Different post',
        created_at: new Date('2026-10-22T08:00:00.000Z'),
      },
    ];
    queryCalls = [];

    const pool = {
      execute: async (sql: string, values: unknown[]) => {
        queryCalls.push({ sql, values });
        if (sql.startsWith('SELECT id FROM posts')) {
          const [postId] = values as [string];
          return [postIds.includes(postId) ? [{ id: postId }] : [], []];
        }
        if (
          sql.startsWith('SELECT id, post_id, author_id, parent_id') &&
          sql.includes('WHERE post_id = ?')
        ) {
          const [postId] = values as [string];
          return [
            comments
              .filter((comment) => comment.post_id === postId)
              .sort(
                (left, right) =>
                  left.created_at.getTime() - right.created_at.getTime() ||
                  left.id.localeCompare(right.id),
              ),
            [],
          ];
        }
        if (
          sql.startsWith('SELECT id FROM comments WHERE id = ? AND post_id')
        ) {
          const [id, postId] = values as [string, string];
          return [
            comments.some(
              (comment) => comment.id === id && comment.post_id === postId,
            )
              ? [{ id }]
              : [],
            [],
          ];
        }
        if (sql.startsWith('INSERT INTO comments')) {
          const [id, postId, authorId, parentId, content] = values as [
            string,
            string,
            string,
            string | null,
            string,
          ];
          comments.push({
            id,
            post_id: postId,
            author_id: authorId,
            parent_id: parentId,
            content,
            created_at: new Date('2026-10-23T08:00:00.000Z'),
          });
          return [{ affectedRows: 1 }, []];
        }
        if (sql.startsWith('SELECT id, post_id, author_id, parent_id')) {
          const [id] = values as [string];
          return [comments.filter((comment) => comment.id === id), []];
        }
        if (sql.startsWith('SELECT id FROM comments')) {
          const [id] = values as [string];
          return [
            comments.some((comment) => comment.id === id) ? [{ id }] : [],
            [],
          ];
        }
        if (sql.startsWith('DELETE comments FROM comments')) {
          const [id] = values as [string];
          const [commentId, authorId, creatorId, moderatorId] =
            values as string[];
          const root = comments.find((comment) => comment.id === commentId);
          const communityId =
            root?.post_id === 'post-1' ? 'community-1' : 'community-2';
          const authorized =
            root !== undefined &&
            (root.author_id === authorId ||
              communityCreators.get(communityId) === creatorId ||
              moderatorAssignments.has(`${communityId}:${moderatorId}`));
          if (!authorized || !root) {
            return [{ affectedRows: 0 }, []];
          }
          const deletedIds = new Set([commentId]);
          let hasNewDescendants = true;
          while (hasNewDescendants) {
            hasNewDescendants = false;
            for (const comment of comments) {
              if (
                comment.parent_id !== null &&
                deletedIds.has(comment.parent_id) &&
                !deletedIds.has(comment.id)
              ) {
                deletedIds.add(comment.id);
                hasNewDescendants = true;
              }
            }
          }
          comments = comments.filter((comment) => !deletedIds.has(comment.id));
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected SQL query: ${sql}`);
      },
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue(pool)
      .overrideProvider(AuthService)
      .useValue({
        validateAccessToken: async (token: string) =>
          token === 'valid-token'
            ? 'user-1'
            : token === 'moderator-token'
              ? 'user-mod'
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

  it('returns comments as a stable hierarchical thread', async () => {
    const response = await request(app.getHttpServer())
      .get('/posts/post-1/comments')
      .expect(200);

    expect(response.body.post_id).toBe('post-1');
    expect(
      response.body.comments.map((comment: TestComment) => comment.id),
    ).toEqual(['root-1', 'root-2']);
    expect(response.body.comments[0].replies[0]).toMatchObject({
      id: 'reply-1',
      parent_id: 'root-1',
      replies: [{ id: 'nested-reply', parent_id: 'reply-1' }],
    });
    expect(response.body.comments[1].replies).toEqual([]);

    const missing = await request(app.getHttpServer())
      .get('/posts/unknown/comments')
      .expect(404);
    expect(missing.body.message).toBe('Post not found');
  });

  it('creates top-level and nested comments for the authenticated user', async () => {
    const topLevel = await request(app.getHttpServer())
      .post('/posts/post-1/comments')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: ' New root ' })
      .expect(201);
    expect(topLevel.body).toMatchObject({
      author_id: 'user-1',
      post_id: 'post-1',
      parent_id: null,
      content: 'New root',
      replies: [],
    });

    const reply = await request(app.getHttpServer())
      .post('/posts/post-1/comments')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'A reply', parent_id: 'root-1' })
      .expect(201);
    expect(reply.body).toMatchObject({
      author_id: 'user-1',
      post_id: 'post-1',
      parent_id: 'root-1',
    });
    expect(
      queryCalls.find((call) => call.sql.startsWith('INSERT INTO comments'))
        ?.values[2],
    ).toBe('user-1');
  });

  it('validates content, authentication, post existence, and same-post parents', async () => {
    const endpoint = '/posts/post-1/comments';
    await request(app.getHttpServer())
      .post(endpoint)
      .send({ content: 'Unauthenticated' })
      .expect(401);
    await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', 'Bearer valid-token')
      .send({ content: '  ' })
      .expect(400);
    await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'Comment', author_id: 'attacker' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/posts/missing-post/comments')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'Comment' })
      .expect(404);
    await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'Comment', parent_id: 'unknown-parent' })
      .expect(404);
    await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'Comment', parent_id: 'other-post-comment' })
      .expect(404);
  });

  it('deletes only the author’s comments and cascades deletion to descendants', async () => {
    await request(app.getHttpServer())
      .delete('/comments/root-2')
      .set('Authorization', 'Bearer valid-token')
      .expect(403);
    expect(comments.some((comment) => comment.id === 'root-2')).toBe(true);

    await request(app.getHttpServer())
      .delete('/comments/other-post-comment')
      .set('Authorization', 'Bearer valid-token')
      .expect(403);
    await request(app.getHttpServer())
      .delete('/comments/missing')
      .set('Authorization', 'Bearer valid-token')
      .expect(404);
    await request(app.getHttpServer()).delete('/comments/root-1').expect(401);

    await request(app.getHttpServer())
      .delete('/comments/root-1')
      .set('Authorization', 'Bearer valid-token')
      .expect(204);

    expect(
      comments.some((comment) =>
        ['root-1', 'reply-1', 'nested-reply'].includes(comment.id),
      ),
    ).toBe(false);
    expect(comments.some((comment) => comment.id === 'root-2')).toBe(true);
  });

  it('allows a moderator to delete comments only in their community', async () => {
    await request(app.getHttpServer())
      .delete('/comments/reply-1')
      .set('Authorization', 'Bearer moderator-token')
      .expect(204);
    expect(comments.some((comment) => comment.id === 'reply-1')).toBe(false);

    await request(app.getHttpServer())
      .delete('/comments/other-post-comment')
      .set('Authorization', 'Bearer moderator-token')
      .expect(403);
    expect(
      comments.some((comment) => comment.id === 'other-post-comment'),
    ).toBe(true);
  });
});
