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
  eligibleRecipients,
  recipientFixture,
} from './fakes/community-notification-recipients';

interface TestNotification {
  id: string;
  recipient_id: string;
  type: string;
  actor_id: string;
  subject_id: string;
  community_id: string;
  metadata: string | null;
}

interface TestPost {
  id: string;
  title: string;
  content: string | null;
  type: 'text' | 'link' | 'media';
  author_id: string;
  community_id: string;
  created_at: Date;
}

describe('Post endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let posts: TestPost[];
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let notifications: TestNotification[];
  let failNotificationWrite: boolean;
  let openConnections: number;
  const communities = [
    'community-1',
    'community-2',
    ...recipientFixture.communities,
  ];
  const communityCreators = new Map([['community-1', 'creator-1']]);
  const moderatorAssignments = new Set(['community-1:user-mod']);

  beforeEach(async () => {
    posts = [
      {
        id: 'post-1',
        title: 'First',
        content: 'First body',
        type: 'text',
        author_id: 'user-1',
        community_id: 'community-1',
        created_at: new Date('2026-10-22T08:00:00.000Z'),
      },
      {
        id: 'post-2',
        title: 'Second',
        content: 'Second body',
        type: 'text',
        author_id: 'user-2',
        community_id: 'community-1',
        created_at: new Date('2026-10-22T08:00:00.000Z'),
      },
      {
        id: 'post-3',
        title: 'Third',
        content: 'Third body',
        type: 'text',
        author_id: 'user-3',
        community_id: 'community-2',
        created_at: new Date('2026-10-21T08:00:00.000Z'),
      },
    ];
    queryCalls = [];
    notifications = [];
    failNotificationWrite = false;
    openConnections = 0;

    // Evaluates the fan-out's recipient selection over the shared fixture;
    // the bound values are community id, then author id.
    const fanOutRecipients = (communityId: unknown, authorId: unknown) =>
      eligibleRecipients(
        recipientFixture.subscriptions,
        recipientFixture.preferences,
        communityId as string,
      ).filter((userId) => userId !== authorId);

    const pool = {
      execute: async (sql: string, values: unknown[]) => {
        queryCalls.push({ sql, values });

        if (sql.startsWith('SELECT COUNT(*) AS recipients')) {
          return [
            [{ recipients: fanOutRecipients(values[0], values[1]).length }],
            [],
          ];
        }
        if (sql.startsWith('INSERT INTO notifications')) {
          if (failNotificationWrite) {
            throw new Error('notification write failed');
          }
          const [actorId, subjectId, communityId, metadata] = values as [
            string,
            string,
            string,
            string | null,
          ];
          for (const recipientId of fanOutRecipients(values[4], values[5])) {
            if (
              !notifications.some(
                (row) =>
                  row.recipient_id === recipientId &&
                  row.subject_id === subjectId,
              )
            ) {
              notifications.push({
                id: `notification-${notifications.length + 1}`,
                recipient_id: recipientId,
                type: 'community_post',
                actor_id: actorId,
                subject_id: subjectId,
                community_id: communityId,
                metadata,
              });
            }
          }
          return [{ affectedRows: 1 }, []];
        }

        if (sql.startsWith('SELECT id FROM communities')) {
          const [id] = values as [string];
          return [communities.includes(id) ? [{ id }] : [], []];
        }
        if (sql.startsWith('INSERT INTO posts')) {
          const [id, title, content, type, authorId, communityId] = values as [
            string,
            string,
            string,
            TestPost['type'],
            string,
            string,
          ];
          posts.push({
            id,
            title,
            content,
            type,
            author_id: authorId,
            community_id: communityId,
            created_at: new Date('2026-10-23T08:00:00.000Z'),
          });
          return [{ affectedRows: 1 }, []];
        }
        if (sql.startsWith('SELECT COUNT(*) AS total')) {
          return [[{ total: filteredPosts(sql, values).length }], []];
        }
        if (sql.includes('ORDER BY created_at DESC')) {
          const rows = filteredPosts(sql, values).sort(
            (left, right) =>
              right.created_at.getTime() - left.created_at.getTime() ||
              right.id.localeCompare(left.id),
          );
          const limit = values[values.length - 2] as number;
          const offset = values[values.length - 1] as number;
          return [rows.slice(offset, offset + limit), []];
        }
        if (sql.startsWith('SELECT id, title, content, type')) {
          const [id] = values as [string];
          return [posts.filter((post) => post.id === id), []];
        }
        if (sql.startsWith('SELECT id FROM posts')) {
          const [id] = values as [string];
          return [posts.some((post) => post.id === id) ? [{ id }] : [], []];
        }
        if (sql.startsWith('DELETE FROM posts')) {
          const [id, authorId, creatorId, moderatorId] = values as string[];
          const post = posts.find((entry) => entry.id === id);
          const authorized =
            post !== undefined &&
            (post.author_id === authorId ||
              communityCreators.get(post.community_id) === creatorId ||
              moderatorAssignments.has(`${post.community_id}:${moderatorId}`));
          if (!authorized) {
            return [{ affectedRows: 0 }, []];
          }
          posts.splice(posts.indexOf(post), 1);
          return [{ affectedRows: 1 }, []];
        }
        if (sql.startsWith('SELECT author_id, community_id FROM posts')) {
          const [id] = values as [string];
          const post = posts.find((entry) => entry.id === id);
          return [
            post
              ? [
                  {
                    author_id: post.author_id,
                    community_id: post.community_id,
                  },
                ]
              : [],
            [],
          ];
        }
        throw new Error(`Unexpected SQL query: ${sql}`);
      },
      // A transaction snapshots the stored rows and restores them on
      // rollback, so a failed request leaves nothing behind.
      getConnection: () => {
        openConnections += 1;
        let snapshot: {
          posts: TestPost[];
          notifications: TestNotification[];
        } | null = null;
        return Promise.resolve({
          execute: (sql: string, values: unknown[]): Promise<unknown> =>
            pool.execute(sql, values),
          beginTransaction: () => {
            snapshot = { posts: [...posts], notifications: [...notifications] };
            return Promise.resolve();
          },
          commit: () => {
            snapshot = null;
            return Promise.resolve();
          },
          rollback: () => {
            if (snapshot) {
              posts = snapshot.posts;
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
      'fixture-author-token': recipientFixture.author,
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

    function filteredPosts(sql: string, values: unknown[]): TestPost[] {
      if (!sql.includes('WHERE community_id = ?')) {
        return posts;
      }
      const [communityId] = values as [string];
      return posts.filter((post) => post.community_id === communityId);
    }
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists posts by community with stable new pagination', async () => {
    const firstPage = await request(app.getHttpServer())
      .get('/posts?community_id=community-1&page=1&limit=1&sort=new')
      .expect(200);

    expect(firstPage.body).toMatchObject({
      page: 1,
      limit: 1,
      total: 2,
      sort: 'new',
      items: [{ id: 'post-2', title: 'Second' }],
    });
    const listedPost = firstPage.body.items[0] as Record<string, unknown>;
    expect(listedPost).not.toHaveProperty('email');
    expect(listedPost).not.toHaveProperty('password_hash');
    expect(listedPost).not.toHaveProperty('auth_sessions');
    const secondPage = await request(app.getHttpServer())
      .get('/posts?community_id=community-1&page=2&limit=1')
      .expect(200);
    expect(secondPage.body.items).toMatchObject([{ id: 'post-1' }]);

    await request(app.getHttpServer())
      .get('/posts?community_id=community-1%27%20OR%201%3D1')
      .expect(400);
    await request(app.getHttpServer())
      .get('/posts?sort=created_at%20DESC')
      .expect(400);
    await request(app.getHttpServer())
      .get('/posts?unexpected=value')
      .expect(400);
    await request(app.getHttpServer()).get('/posts?page=10001').expect(400);
    await request(app.getHttpServer()).get('/posts?limit=101').expect(400);
  });

  it('creates supported post types for the authenticated author', async () => {
    const cases = [
      {
        title: 'Text',
        type: 'text',
        content: 'A text body',
      },
      {
        title: 'Link',
        type: 'link',
        content: 'https://example.com/article',
      },
      {
        title: 'Media',
        type: 'media',
        content: 'https://example.com/image.png',
      },
    ];

    for (const post of cases) {
      const response = await request(app.getHttpServer())
        .post('/posts')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...post, community_id: 'community-1' })
        .expect(201);

      expect(response.body).toMatchObject({
        ...post,
        author_id: 'user-1',
        community_id: 'community-1',
        id: expect.any(String),
        created_at: expect.any(String),
      });
      expect(Object.keys(response.body).sort()).toEqual(
        [
          'author_id',
          'community_id',
          'content',
          'created_at',
          'id',
          'title',
          'type',
        ].sort(),
      );
      expect(response.body).not.toHaveProperty('email');
      expect(response.body).not.toHaveProperty('password_hash');
    }
    expect(
      queryCalls.filter((call) => call.sql.startsWith('INSERT INTO posts')),
    ).toHaveLength(3);
  });

  it('stores HTML-looking post content as inert plain text', async () => {
    const content = '<script>alert("stored-xss")</script>';
    const response = await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({
        title: 'Literal markup example',
        type: 'text',
        content,
        community_id: 'community-1',
      })
      .expect(201);

    expect(response.headers['content-type']).toMatch(/application\/json/);
    const responseBody = response.body as { content: string };
    expect(responseBody.content).toBe(content);

    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({
        title: 'Control character',
        type: 'text',
        content: 'valid\u0000<script>alert(1)</script>',
        community_id: 'community-1',
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({
        title: 'SQL-shaped community ID',
        type: 'text',
        content: 'valid text',
        community_id: "community-1' OR 1=1 --",
      })
      .expect(400);
  });

  it('rejects missing authentication, invalid data, and unknown communities', async () => {
    const endpoint = request(app.getHttpServer()).post('/posts');
    const post = {
      title: 'A valid title',
      type: 'text',
      content: 'A valid body',
      community_id: 'community-1',
    };

    await endpoint.send(post).expect(401);
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...post, type: 'video' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...post, title: 'x'.repeat(301) })
      .expect(400);
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...post, content: '' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...post, type: 'link', content: 'not-a-url' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...post, type: 'media', content: 'file://local/image.png' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({
        ...post,
        type: 'link',
        content: 'https://user:password@example.com/private',
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({
        ...post,
        type: 'link',
        content: 'https://example.com/\njavascript:alert(1)',
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...post, community_id: 'missing-community' })
      .expect(404);
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({ ...post, author_id: 'attacker' })
      .expect(400);
  });

  it('returns posts by ID and 404 for unknown IDs', async () => {
    const response = await request(app.getHttpServer())
      .get('/posts/post-1')
      .expect(200);
    expect(response.body).toMatchObject({
      id: 'post-1',
      author_id: 'user-1',
      community_id: 'community-1',
    });
    expect(response.body).not.toHaveProperty('email');
    expect(response.body).not.toHaveProperty('password_hash');

    const missing = await request(app.getHttpServer())
      .get('/posts/unknown')
      .expect(404);
    expect(missing.body.message).toBe('Post not found');

    await request(app.getHttpServer())
      .get('/posts/post-1%27%20OR%201%3D1')
      .expect(400);
  });

  it('allows authors and community-scoped moderators to delete posts', async () => {
    await request(app.getHttpServer())
      .delete('/posts/post-2')
      .set('Authorization', 'Bearer valid-token')
      .expect(403);
    expect(posts.some((post) => post.id === 'post-2')).toBe(true);

    await request(app.getHttpServer())
      .delete('/posts/post-2')
      .set('Authorization', 'Bearer moderator-token')
      .expect(204);
    expect(posts.some((post) => post.id === 'post-2')).toBe(false);

    await request(app.getHttpServer())
      .delete('/posts/post-3')
      .set('Authorization', 'Bearer moderator-token')
      .expect(403);
    expect(posts.some((post) => post.id === 'post-3')).toBe(true);

    await request(app.getHttpServer())
      .delete('/posts/post-1')
      .set('Authorization', 'Bearer valid-token')
      .expect(204);
    expect(posts.some((post) => post.id === 'post-1')).toBe(false);
    expect(
      queryCalls.some(
        (call) =>
          call.sql.startsWith('DELETE FROM posts') &&
          call.values[0] === 'post-1',
      ),
    ).toBe(true);

    await request(app.getHttpServer())
      .delete('/posts/unknown')
      .set('Authorization', 'Bearer valid-token')
      .expect(404);
    await request(app.getHttpServer()).delete('/posts/post-1').expect(401);
  });

  describe('community_post notifications', () => {
    const post = {
      title: 'Harvest day',
      type: 'text',
      content: 'Bring baskets',
      community_id: recipientFixture.communityId,
    };

    it('notifies unmuted members and members without a row, never muted members, non-members or the author', async () => {
      const response = await request(app.getHttpServer())
        .post('/posts')
        .set('Authorization', 'Bearer fixture-author-token')
        .send(post)
        .expect(201);

      expect(notifications.map((row) => row.recipient_id).sort()).toEqual(
        recipientFixture.notified,
      );
      for (const row of notifications) {
        expect(row).toMatchObject({
          type: 'community_post',
          actor_id: recipientFixture.author,
          subject_id: (response.body as { id: string }).id,
          community_id: recipientFixture.communityId,
        });
        expect(JSON.parse(row.metadata as string)).toEqual({
          post_title: 'Harvest day',
        });
      }
      expect(
        queryCalls.filter((call) =>
          call.sql.startsWith('INSERT INTO notifications'),
        ),
      ).toHaveLength(1);
      expect(openConnections).toBe(0);
    });

    it('writes nothing in a community without eligible members', async () => {
      await request(app.getHttpServer())
        .post('/posts')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...post, community_id: 'community-1' })
        .expect(201);

      expect(notifications).toEqual([]);
      expect(
        queryCalls.some((call) =>
          call.sql.startsWith('INSERT INTO notifications'),
        ),
      ).toBe(false);
    });

    it('leaves no post behind when the notification write fails', async () => {
      failNotificationWrite = true;
      const before = posts.length;

      await request(app.getHttpServer())
        .post('/posts')
        .set('Authorization', 'Bearer fixture-author-token')
        .send(post)
        .expect(500);

      expect(posts).toHaveLength(before);
      expect(posts.some((entry) => entry.title === 'Harvest day')).toBe(false);
      expect(notifications).toEqual([]);
      expect(openConnections).toBe(0);
    });
  });
});
