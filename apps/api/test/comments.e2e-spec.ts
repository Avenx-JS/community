import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { CommunityRuleAcceptanceService } from '../src/communities/community-rule-acceptance.service';
import {
  createRulesStore,
  type RulesStore,
} from './fakes/community-rules-store';

interface TestNotification {
  id: string;
  recipient_id: string;
  type: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string;
  community_id: string | null;
  metadata: string | null;
  read_at: Date | null;
  created_at: Date;
}

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
  let notifications: TestNotification[];
  let failNotificationWrite: boolean;
  let openConnections: number;
  let rules: RulesStore;
  const postIds = ['post-1', 'post-2'];
  const postAuthors = new Map([
    ['post-1', 'user-2'],
    ['post-2', 'user-1'],
  ]);
  const postCommunities = new Map([
    ['post-1', 'community-1'],
    ['post-2', 'community-2'],
  ]);
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
    notifications = [];
    failNotificationWrite = false;
    openConnections = 0;
    // No community has published rules unless a test publishes some.
    rules = createRulesStore({
      'community-1': { name: 'general', creator_id: 'creator-1' },
      'community-2': { name: 'other', creator_id: 'creator-2' },
    });

    const pool = {
      execute: async (sql: string, values: unknown[]) => {
        queryCalls.push({ sql, values });
        const ruleAnswer = rules.handle(sql, values);
        if (ruleAnswer) {
          return ruleAnswer;
        }
        if (sql.startsWith('SELECT id, author_id, community_id, title')) {
          const [postId] = values as [string];
          return [
            postIds.includes(postId)
              ? [
                  {
                    id: postId,
                    author_id: postAuthors.get(postId),
                    community_id: postCommunities.get(postId),
                    title: `Title of ${postId}`,
                  },
                ]
              : [],
            [],
          ];
        }
        if (sql.startsWith('INSERT INTO notifications')) {
          if (failNotificationWrite) {
            throw new Error('notification write failed');
          }
          for (let index = 0; index < values.length; index += 8) {
            const [
              id,
              recipientId,
              type,
              actorId,
              subjectType,
              subjectId,
              communityId,
              metadata,
            ] = values.slice(index, index + 8) as Array<string | null>;
            const duplicate = notifications.some(
              (row) =>
                row.recipient_id === recipientId &&
                row.type === type &&
                row.subject_type === subjectType &&
                row.subject_id === subjectId,
            );
            if (!duplicate) {
              notifications.push({
                id: id as string,
                recipient_id: recipientId as string,
                type: type as string,
                actor_id: actorId,
                subject_type: subjectType as string,
                subject_id: subjectId as string,
                community_id: communityId,
                metadata,
                read_at: null,
                created_at: new Date('2026-10-23T08:00:00.000Z'),
              });
            }
          }
          return [{ affectedRows: 1 }, []];
        }
        if (sql.startsWith('SELECT COUNT(*) AS total FROM notifications')) {
          const [recipientId] = values as [string];
          return [
            [
              {
                total: notifications.filter(
                  (row) => row.recipient_id === recipientId,
                ).length,
              },
            ],
            [],
          ];
        }
        if (
          sql.startsWith('SELECT id, type, subject_type') &&
          sql.includes('FROM notifications WHERE recipient_id = ?')
        ) {
          const [recipientId] = values as [string];
          return [
            notifications.filter((row) => row.recipient_id === recipientId),
            [],
          ];
        }
        if (sql.startsWith('SELECT id FROM posts')) {
          const [postId] = values as [string];
          return [postIds.includes(postId) ? [{ id: postId }] : [], []];
        }
        if (
          sql.startsWith('SELECT id, post_id, author_id, parent_id') &&
          sql.includes('WHERE post_id = ?')
        ) {
          const [postId, limit] = values as [string, number];
          return [
            comments
              .filter((comment) => comment.post_id === postId)
              .sort(
                (left, right) =>
                  left.created_at.getTime() - right.created_at.getTime() ||
                  left.id.localeCompare(right.id),
              )
              .slice(0, limit),
            [],
          ];
        }
        if (
          sql.startsWith(
            'SELECT id, author_id FROM comments WHERE id = ? AND post_id',
          )
        ) {
          const [id, postId] = values as [string, string];
          return [
            comments
              .filter(
                (comment) => comment.id === id && comment.post_id === postId,
              )
              .map((comment) => ({ id, author_id: comment.author_id })),
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
        if (sql.startsWith('SELECT comments.id, comments.author_id')) {
          const [creatorId, moderatorId, commentId] = values as string[];
          const comment = comments.find((entry) => entry.id === commentId);
          if (!comment) {
            return [[], []];
          }
          const communityId = postCommunities.get(comment.post_id) as string;
          return [
            [
              {
                id: comment.id,
                author_id: comment.author_id,
                content: comment.content,
                community_id: communityId,
                can_moderate:
                  communityCreators.get(communityId) === creatorId ||
                  moderatorAssignments.has(`${communityId}:${moderatorId}`)
                    ? 1
                    : 0,
              },
            ],
            [],
          ];
        }
        if (sql === 'DELETE FROM comments WHERE id = ?') {
          const [commentId] = values as [string];
          // ON DELETE CASCADE on comments.parent_id.
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
      // A transaction snapshots the stored rows and restores them on
      // rollback, so a failed request leaves nothing behind.
      getConnection: () => {
        openConnections += 1;
        let snapshot: {
          comments: TestComment[];
          notifications: TestNotification[];
        } | null = null;
        return Promise.resolve({
          execute: (sql: string, values: unknown[]): Promise<unknown> =>
            pool.execute(sql, values),
          beginTransaction: () => {
            snapshot = {
              comments: [...comments],
              notifications: [...notifications],
            };
            return Promise.resolve();
          },
          commit: () => {
            snapshot = null;
            return Promise.resolve();
          },
          rollback: () => {
            if (snapshot) {
              comments = snapshot.comments;
              notifications = snapshot.notifications;
            }
            return Promise.resolve();
          },
          release: () => {
            openConnections -= 1;
          },
        });
      },
    };
    const userIds: Record<string, string> = {
      'valid-token': 'user-1',
      'moderator-token': 'user-mod',
      'post-author-token': 'user-2',
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue(pool)
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            token in userIds
              ? { kind: 'valid', userId: userIds[token] }
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
    const rootComment = response.body.comments[0] as Record<string, unknown>;
    expect(rootComment).not.toHaveProperty('email');
    expect(rootComment).not.toHaveProperty('password_hash');
    expect(rootComment).not.toHaveProperty('auth_sessions');
    expect(
      queryCalls.find((call) => call.sql.includes('ORDER BY created_at ASC'))
        ?.values,
    ).toEqual(['post-1', 501]);

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
    expect(Object.keys(topLevel.body).sort()).toEqual(
      [
        'author_id',
        'content',
        'created_at',
        'id',
        'parent_id',
        'post_id',
        'replies',
      ].sort(),
    );
    expect(topLevel.body).not.toHaveProperty('email');
    expect(topLevel.body).not.toHaveProperty('password_hash');

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

  it('returns HTML-looking comment content as plain JSON text', async () => {
    const content = '<img src=x onerror=alert(1)>';
    const response = await request(app.getHttpServer())
      .post('/posts/post-1/comments')
      .set('Authorization', 'Bearer valid-token')
      .send({ content })
      .expect(201);

    expect(response.headers['content-type']).toMatch(/application\/json/);
    const responseBody = response.body as { content: string };
    expect(responseBody.content).toBe(content);
    expect(
      queryCalls.find((call) => call.sql.startsWith('INSERT INTO comments'))
        ?.values[4],
    ).toBe(content);
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
      .send({ content: 'invalid\u0000comment' })
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
    await request(app.getHttpServer())
      .post('/posts/post-1%27%20OR%201%3D1/comments')
      .set('Authorization', 'Bearer valid-token')
      .send({ content: 'Comment' })
      .expect(400);
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

  describe('notifications', () => {
    it('notifies the post author exactly once about a top-level comment', async () => {
      const response = await request(app.getHttpServer())
        .post('/posts/post-1/comments')
        .set('Authorization', 'Bearer valid-token')
        .send({ content: ' Nice harvest ' })
        .expect(201);
      const { id } = response.body as { id: string };

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        recipient_id: 'user-2',
        type: 'post_comment',
        actor_id: 'user-1',
        subject_type: 'comment',
        subject_id: id,
        community_id: 'community-1',
      });
      expect(JSON.parse(notifications[0].metadata as string)).toEqual({
        post_id: 'post-1',
        post_title: 'Title of post-1',
        excerpt: 'Nice harvest',
      });
      expect(openConnections).toBe(0);
    });

    it('notifies only the parent comment author about a reply', async () => {
      const response = await request(app.getHttpServer())
        .post('/posts/post-1/comments')
        .set('Authorization', 'Bearer valid-token')
        .send({ content: 'Agreed', parent_id: 'root-2' })
        .expect(201);
      const { id } = response.body as { id: string };

      expect(notifications).toEqual([
        expect.objectContaining({
          recipient_id: 'user-3',
          type: 'comment_reply',
          subject_type: 'comment',
          subject_id: id,
        }),
      ]);
      expect(JSON.parse(notifications[0].metadata as string)).toEqual({
        post_id: 'post-1',
        parent_comment_id: 'root-2',
        excerpt: 'Agreed',
      });
    });

    it('writes nothing for your own post or your own comment', async () => {
      await request(app.getHttpServer())
        .post('/posts/post-2/comments')
        .set('Authorization', 'Bearer valid-token')
        .send({ content: 'On my own post' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/posts/post-1/comments')
        .set('Authorization', 'Bearer valid-token')
        .send({ content: 'On my own comment', parent_id: 'root-1' })
        .expect(201);

      expect(notifications).toEqual([]);
    });

    it('rolls the comment back when the notification write fails', async () => {
      failNotificationWrite = true;
      const before = comments.length;

      await request(app.getHttpServer())
        .post('/posts/post-1/comments')
        .set('Authorization', 'Bearer valid-token')
        .send({ content: 'Lost' })
        .expect(500);

      expect(comments).toHaveLength(before);
      expect(comments.some((comment) => comment.content === 'Lost')).toBe(
        false,
      );
      expect(notifications).toEqual([]);
      expect(openConnections).toBe(0);
    });

    it('still renders in the inbox after the comment is deleted', async () => {
      const created = await request(app.getHttpServer())
        .post('/posts/post-1/comments')
        .set('Authorization', 'Bearer valid-token')
        .send({ content: 'Soon gone' })
        .expect(201);
      const { id } = created.body as { id: string };
      await request(app.getHttpServer())
        .delete(`/comments/${id}`)
        .set('Authorization', 'Bearer valid-token')
        .expect(204);
      expect(comments.some((comment) => comment.id === id)).toBe(false);

      const inbox = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', 'Bearer post-author-token')
        .expect(200);
      const body = inbox.body as { total: number; items: unknown[] };

      expect(body.total).toBe(1);
      expect(body.items[0]).toMatchObject({
        type: 'post_comment',
        subject_id: id,
        metadata: {
          post_id: 'post-1',
          post_title: 'Title of post-1',
          excerpt: 'Soon gone',
        },
      });
    });

    it('notifies only the author of a comment a moderator removes, and renders it once gone', async () => {
      await request(app.getHttpServer())
        .delete('/comments/reply-1')
        .set('Authorization', 'Bearer moderator-token')
        .expect(204);

      expect(comments.some((comment) => comment.id === 'reply-1')).toBe(false);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        recipient_id: 'user-2',
        type: 'content_removed',
        actor_id: null,
        subject_type: 'comment',
        subject_id: 'reply-1',
        community_id: 'community-1',
      });
      expect(JSON.parse(notifications[0].metadata as string)).toEqual({
        excerpt: 'Reply',
      });

      const inbox = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', 'Bearer post-author-token')
        .expect(200);
      const body = inbox.body as { total: number; items: unknown[] };
      expect(body.total).toBe(1);
      expect(body.items[0]).toMatchObject({
        type: 'content_removed',
        actor_username: null,
        subject_id: 'reply-1',
        metadata: { excerpt: 'Reply' },
      });
      expect(JSON.stringify(inbox.body)).not.toContain('user-mod');
    });

    it('writes nothing when the author deletes their own comment', async () => {
      await request(app.getHttpServer())
        .delete('/comments/root-1')
        .set('Authorization', 'Bearer valid-token')
        .expect(204);

      expect(notifications).toEqual([]);
    });

    it('keeps the comment when the removal notification cannot be written', async () => {
      failNotificationWrite = true;

      await request(app.getHttpServer())
        .delete('/comments/reply-1')
        .set('Authorization', 'Bearer moderator-token')
        .expect(500);

      expect(comments.some((comment) => comment.id === 'reply-1')).toBe(true);
      expect(comments.some((comment) => comment.id === 'nested-reply')).toBe(
        true,
      );
      expect(openConnections).toBe(0);
    });
  });

  describe('rule acceptance', () => {
    const as = (token: string) => ({
      post: (path: string) =>
        request(app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${token}`),
      get: (path: string) =>
        request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${token}`),
      delete: (path: string) =>
        request(app.getHttpServer())
          .delete(path)
          .set('Authorization', `Bearer ${token}`),
    });

    it('refuses comments and replies until the rules are accepted, then creates them', async () => {
      rules.publish('community-1');
      const before = comments.length;

      for (const body of [
        { content: 'Top level' },
        { content: 'Reply', parent_id: 'root-1' },
      ]) {
        const refused = await as('valid-token')
          .post('/posts/post-1/comments')
          .send(body)
          .expect(403);
        expect(refused.body).toEqual({
          reason: 'community_rules_not_accepted',
          community: 'general',
          current_version: 1,
        });
        expect(JSON.stringify(refused.body)).not.toMatch(
          /user-1|community-1|rules-v|creator/,
        );
      }
      expect(comments).toHaveLength(before);
      expect(notifications).toEqual([]);
      expect(openConnections).toBe(0);

      await as('valid-token')
        .post('/communities/general/rules/acceptance')
        .send({ version: 1 })
        .expect(201);
      await as('valid-token')
        .post('/posts/post-1/comments')
        .send({ content: 'Reply', parent_id: 'root-1' })
        .expect(201);
      expect(comments).toHaveLength(before + 1);
    });

    it('returns 404, not 403, for an unknown post or parent', async () => {
      rules.publish('community-1');

      await as('valid-token')
        .post('/posts/missing-post/comments')
        .send({ content: 'Comment' })
        .expect(404);
      await as('valid-token')
        .post('/posts/post-1/comments')
        .send({ content: 'Comment', parent_id: 'unknown-parent' })
        .expect(404);
    });

    it('lets authors and moderators delete, and anyone read, without accepting', async () => {
      rules.publish('community-1');
      const check = jest.spyOn(
        app.get(CommunityRuleAcceptanceService),
        'assertAcceptedOrThrow',
      );

      await as('valid-token').get('/posts/post-1/comments').expect(200);
      await as('valid-token').delete('/comments/root-1').expect(204);
      await as('moderator-token').delete('/comments/root-2').expect(204);

      expect(check).not.toHaveBeenCalled();
    });
  });
});
