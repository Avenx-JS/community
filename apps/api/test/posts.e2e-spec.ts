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
import {
  eligibleRecipients,
  recipientFixture,
} from './fakes/community-notification-recipients';
import {
  createRulesStore,
  type RulesStore,
} from './fakes/community-rules-store';
import { CommunityRuleAcceptanceService } from '../src/communities/community-rule-acceptance.service';
import { answerVoteScores, type FakeVote } from './fakes/vote-scores';

interface TestNotification {
  id: string;
  recipient_id: string;
  type: string;
  actor_id: string | null;
  subject_type: string;
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
  pinned_at: Date | null;
  pinned_by: string | null;
  removed_at?: Date | null;
}

interface TestModerationEntry {
  community_id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
}

describe('Post endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let posts: TestPost[];
  let votes: FakeVote[];
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let notifications: TestNotification[];
  let failNotificationWrite: boolean;
  let rules: RulesStore;
  let openConnections: number;
  let deletedCommunities: Set<string>;
  let moderationLog: TestModerationEntry[];
  let failModerationLog: boolean;
  let pinClock: number;
  const communities = [
    'community-1',
    'community-2',
    ...recipientFixture.communities,
  ];
  const communityCreators = new Map([['community-1', 'creator-1']]);
  const moderatorAssignments = new Set([
    'community-1:user-mod',
    'community-2:user-other-mod',
  ]);
  const usernames = new Map([
    ['user-1', 'user_one'],
    ['user-mod', 'moderator'],
    ['creator-1', 'creator'],
    ['user-other-mod', 'other_moderator'],
  ]);

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
        pinned_at: null,
        pinned_by: null,
      },
      {
        id: 'post-2',
        title: 'Second',
        content: 'Second body',
        type: 'text',
        author_id: 'user-2',
        community_id: 'community-1',
        created_at: new Date('2026-10-22T08:00:00.000Z'),
        pinned_at: null,
        pinned_by: null,
      },
      {
        id: 'post-3',
        title: 'Third',
        content: 'Third body',
        type: 'text',
        author_id: 'user-3',
        community_id: 'community-2',
        created_at: new Date('2026-10-21T08:00:00.000Z'),
        pinned_at: null,
        pinned_by: null,
      },
    ];
    votes = [];
    queryCalls = [];
    notifications = [];
    failNotificationWrite = false;
    // No community has published rules unless a test publishes some.
    rules = createRulesStore({
      'community-1': { name: 'general', creator_id: 'creator-1' },
      'community-2': { name: 'other', creator_id: 'creator-2' },
    });
    openConnections = 0;
    deletedCommunities = new Set();
    moderationLog = [];
    failModerationLog = false;
    pinClock = 0;
    // A statement that excludes deleted communities does not see a post in
    // one; a statement that forgets the exclusion still does.
    const visible = (post: TestPost, sql: string) =>
      !(
        sql.includes('deleted_at IS NULL') &&
        deletedCommunities.has(post.community_id)
      );

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
        const scoreAnswer = answerVoteScores(sql, values, votes);
        if (scoreAnswer) {
          return scoreAnswer;
        }
        const ruleAnswer = rules.handle(sql, values);
        if (ruleAnswer) {
          return ruleAnswer;
        }

        if (sql.startsWith('SELECT COUNT(*) AS recipients')) {
          return [
            [{ recipients: fanOutRecipients(values[0], values[1]).length }],
            [],
          ];
        }
        if (
          sql.startsWith('INSERT INTO notifications') &&
          !sql.includes('SELECT UUID()')
        ) {
          if (failNotificationWrite) {
            throw new Error('notification write failed');
          }
          const [id, recipientId, type, actorId, subjectType, subjectId] =
            values as Array<string | null>;
          notifications.push({
            id: id as string,
            recipient_id: recipientId as string,
            type: type as string,
            actor_id: actorId,
            subject_type: subjectType as string,
            subject_id: subjectId as string,
            community_id: values[6] as string,
            metadata: values[7] as string | null,
          });
          return [{ affectedRows: 1 }, []];
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
                subject_type: 'post',
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
          const live = !(
            sql.includes('deleted_at IS NULL') && deletedCommunities.has(id)
          );
          return [communities.includes(id) && live ? [{ id }] : [], []];
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
            pinned_at: null,
            pinned_by: null,
          });
          return [{ affectedRows: 1 }, []];
        }
        if (sql.startsWith('SELECT COUNT(*) AS total')) {
          return [[{ total: filteredPosts(sql, values).length }], []];
        }
        if (sql.includes(' ORDER BY ')) {
          // Evaluates the two orders the service issues, and nothing else.
          const floatsPins = sql.includes(
            'ORDER BY (pinned_at IS NULL), pinned_at DESC, created_at DESC, id DESC',
          );
          if (
            !floatsPins &&
            !sql.includes('ORDER BY created_at DESC, id DESC')
          ) {
            throw new Error(`Unexpected order: ${sql}`);
          }
          const pinRank = (post: TestPost) =>
            floatsPins && post.pinned_at ? post.pinned_at.getTime() : 0;
          const rows = filteredPosts(sql, values).sort(
            (left, right) =>
              (floatsPins
                ? Number(!left.pinned_at) - Number(!right.pinned_at)
                : 0) ||
              pinRank(right) - pinRank(left) ||
              right.created_at.getTime() - left.created_at.getTime() ||
              right.id.localeCompare(left.id),
          );
          const limit = values[values.length - 2] as number;
          const offset = values[values.length - 1] as number;
          return [rows.slice(offset, offset + limit), []];
        }
        if (sql.startsWith('SELECT id, title, content, type')) {
          const [id] = values as [string];
          return [
            posts.filter((post) => post.id === id && visible(post, sql)),
            [],
          ];
        }
        if (sql.startsWith('SELECT id FROM posts')) {
          const [id] = values as [string];
          return [
            posts.some((post) => post.id === id && visible(post, sql))
              ? [{ id }]
              : [],
            [],
          ];
        }
        if (sql.startsWith('SELECT posts.id, posts.author_id')) {
          const [creatorId, moderatorId, id] = values as string[];
          const post = posts.find(
            (entry) => entry.id === id && visible(entry, sql),
          );
          return [
            post
              ? [
                  {
                    id: post.id,
                    author_id: post.author_id,
                    community_id: post.community_id,
                    title: post.title,
                    can_moderate:
                      communityCreators.get(post.community_id) === creatorId ||
                      moderatorAssignments.has(
                        `${post.community_id}:${moderatorId}`,
                      )
                        ? 1
                        : 0,
                  },
                ]
              : [],
            [],
          ];
        }
        if (sql.startsWith('SELECT posts.id, posts.community_id')) {
          const [creatorId, moderatorId, id] = values as string[];
          const post = posts.find(
            (entry) => entry.id === id && visible(entry, sql),
          );
          return [
            post
              ? [
                  {
                    id: post.id,
                    community_id: post.community_id,
                    pinned_at: post.pinned_at,
                    removed_at: post.removed_at ?? null,
                    can_moderate:
                      communityCreators.get(post.community_id) === creatorId ||
                      moderatorAssignments.has(
                        `${post.community_id}:${moderatorId}`,
                      )
                        ? 1
                        : 0,
                  },
                ]
              : [],
            [],
          ];
        }
        if (sql.startsWith('SELECT COUNT(*) AS pinned FROM posts')) {
          const [communityId] = values as [string];
          return [
            [
              {
                pinned: posts.filter(
                  (post) => post.community_id === communityId && post.pinned_at,
                ).length,
              },
            ],
            [],
          ];
        }
        if (sql.startsWith('UPDATE posts SET pinned_at = UTC_TIMESTAMP()')) {
          const [actorId, id] = values as [string, string];
          let affectedRows = 0;
          // Rows are replaced, never mutated, so a rollback restores them.
          posts = posts.map((post) => {
            if (post.id !== id || post.pinned_at) {
              return post;
            }
            affectedRows += 1;
            pinClock += 1;
            return {
              ...post,
              pinned_at: new Date(Date.UTC(2026, 10, 1, 8, pinClock)),
              pinned_by: actorId,
            };
          });
          return [{ affectedRows }, []];
        }
        if (sql.startsWith('UPDATE posts SET pinned_at = NULL')) {
          const [id] = values as [string];
          let affectedRows = 0;
          posts = posts.map((post) => {
            if (post.id !== id || !post.pinned_at) {
              return post;
            }
            affectedRows += 1;
            return { ...post, pinned_at: null, pinned_by: null };
          });
          return [{ affectedRows }, []];
        }
        if (sql === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
          const username = usernames.get(values[0] as string);
          return [username ? [{ username }] : [], []];
        }
        if (sql.startsWith('INSERT INTO community_moderation_actions')) {
          if (failModerationLog) {
            throw new Error('moderation log write failed');
          }
          const [, communityId, actorId, , action, targetType, targetId] =
            values as string[];
          moderationLog.push({
            community_id: communityId,
            actor_id: actorId,
            action,
            target_type: targetType,
            target_id: targetId,
          });
          return [{ affectedRows: 1 }, []];
        }
        if (sql === 'DELETE FROM posts WHERE id = ?') {
          const [id] = values as [string];
          posts = posts.filter((entry) => entry.id !== id);
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
          moderationLog: TestModerationEntry[];
        } | null = null;
        return Promise.resolve({
          execute: (sql: string, values: unknown[]): Promise<unknown> =>
            pool.execute(sql, values),
          beginTransaction: () => {
            snapshot = {
              posts: [...posts],
              notifications: [...notifications],
              moderationLog: [...moderationLog],
            };
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
              moderationLog = snapshot.moderationLog;
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
      'creator-token': 'creator-1',
      'other-moderator-token': 'user-other-mod',
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
      const live = posts.filter((post) => visible(post, sql));
      if (!sql.includes('WHERE community_id = ?')) {
        return live;
      }
      const [communityId] = values as [string];
      return live.filter((post) => post.community_id === communityId);
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
          'pinned_at',
          'pinned_by',
          'score',
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

  describe('content_removed notifications', () => {
    it('notifies the author when a moderator removes their post, naming no moderator', async () => {
      await request(app.getHttpServer())
        .delete('/posts/post-1')
        .set('Authorization', 'Bearer moderator-token')
        .expect(204);

      expect(posts.some((post) => post.id === 'post-1')).toBe(false);
      expect(notifications).toEqual([
        {
          id: expect.any(String) as unknown as string,
          recipient_id: 'user-1',
          type: 'content_removed',
          actor_id: null,
          subject_type: 'post',
          subject_id: 'post-1',
          community_id: 'community-1',
          metadata: JSON.stringify({ post_title: 'First' }),
        },
      ]);
      expect(JSON.stringify(notifications)).not.toContain('user-mod');
      expect(openConnections).toBe(0);
    });

    it('writes nothing when the author deletes their own post', async () => {
      await request(app.getHttpServer())
        .delete('/posts/post-1')
        .set('Authorization', 'Bearer valid-token')
        .expect(204);

      expect(notifications).toEqual([]);
    });

    it('keeps the post when the notification cannot be written', async () => {
      failNotificationWrite = true;

      await request(app.getHttpServer())
        .delete('/posts/post-1')
        .set('Authorization', 'Bearer moderator-token')
        .expect(500);

      expect(posts.some((post) => post.id === 'post-1')).toBe(true);
      expect(notifications).toEqual([]);
      expect(openConnections).toBe(0);
    });
  });

  describe('rule acceptance', () => {
    const post = {
      title: 'Hello',
      type: 'text',
      content: 'World',
      community_id: 'community-1',
    };
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

    it('refuses a post until the rules are accepted, then creates it', async () => {
      rules.publish('community-1');
      const before = posts.length;

      const refused = await as('valid-token')
        .post('/posts')
        .send(post)
        .expect(403);
      expect(refused.body).toEqual({
        reason: 'community_rules_not_accepted',
        community: 'general',
        current_version: 1,
      });
      expect(JSON.stringify(refused.body)).not.toMatch(
        /user-1|community-1|rules-v|creator/,
      );
      expect(posts).toHaveLength(before);
      expect(openConnections).toBe(0);

      await as('valid-token')
        .post('/communities/general/rules/acceptance')
        .send({ version: 1 })
        .expect(201);
      await as('valid-token').post('/posts').send(post).expect(201);
      expect(posts).toHaveLength(before + 1);
    });

    it('returns 404, not 403, for an unknown community', async () => {
      rules.publish('community-1');

      await as('valid-token')
        .post('/posts')
        .send({ ...post, community_id: 'missing-community' })
        .expect(404);
    });

    it('lets authors and moderators delete, and anyone read, without accepting', async () => {
      rules.publish('community-1');
      const check = jest.spyOn(
        app.get(CommunityRuleAcceptanceService),
        'assertAcceptedOrThrow',
      );

      await as('valid-token')
        .get('/posts?community_id=community-1')
        .expect(200);
      await as('valid-token').get('/posts/post-1').expect(200);
      await as('valid-token').delete('/posts/post-1').expect(204);
      await as('moderator-token').delete('/posts/post-2').expect(204);

      expect(check).not.toHaveBeenCalled();
    });
  });

  describe('in a deleted community', () => {
    const asAuthor = (method: 'get' | 'post' | 'delete', path: string) =>
      request(app.getHttpServer())
        [method](path)
        .set('Authorization', 'Bearer valid-token');

    beforeEach(() => {
      deletedCommunities.add('community-1');
    });

    it('refuses a new post with the existing 404 and writes nothing', async () => {
      const response = await asAuthor('post', '/posts')
        .send({
          title: 'Still here?',
          type: 'text',
          content: 'Hello',
          community_id: 'community-1',
        })
        .expect(404);

      expect((response.body as { message: string }).message).toBe(
        'Community not found',
      );
      expect(posts).toHaveLength(3);
      expect(notifications).toEqual([]);
      expect(openConnections).toBe(0);
    });

    it('omits its posts from every listing and their totals', async () => {
      const all = await request(app.getHttpServer())
        .get('/posts?limit=100')
        .expect(200);
      const allBody = all.body as { items: { id: string }[]; total: number };
      expect(allBody.items.map((post) => post.id)).toEqual(['post-3']);
      expect(allBody.total).toBe(1);

      const scoped = await request(app.getHttpServer())
        .get('/posts?community_id=community-1')
        .expect(200);
      expect(scoped.body).toMatchObject({ items: [], total: 0 });
    });

    it('answers 404 for its posts, their threads and their deletion', async () => {
      for (const [method, path] of [
        ['get', '/posts/post-1'],
        ['get', '/posts/post-1/comments'],
        ['delete', '/posts/post-1'],
      ] as const) {
        const response = await asAuthor(method, path);
        expect([method, path, response.status]).toEqual([method, path, 404]);
      }
      await request(app.getHttpServer())
        .delete('/posts/post-2')
        .set('Authorization', 'Bearer moderator-token')
        .expect(404);
    });

    it('keeps every post row: the community is hidden, not erased', async () => {
      await asAuthor('get', '/posts/post-1').expect(404);
      await asAuthor('delete', '/posts/post-1').expect(404);

      expect(posts.map((post) => post.id)).toEqual([
        'post-1',
        'post-2',
        'post-3',
      ]);
      expect(
        queryCalls.some(({ sql }) => sql.startsWith('DELETE FROM posts')),
      ).toBe(false);
    });

    it('leaves posts in other communities untouched', async () => {
      await request(app.getHttpServer()).get('/posts/post-3').expect(200);
    });
  });

  describe('pinning', () => {
    const as = (token?: string) => {
      const server = request(app.getHttpServer());
      const withToken = (test: request.Test) =>
        token ? test.set('Authorization', `Bearer ${token}`) : test;
      return {
        pin: (id: string) => withToken(server.post(`/posts/${id}/pin`)),
        unpin: (id: string) => withToken(server.delete(`/posts/${id}/pin`)),
      };
    };
    const listIds = async (query: string) => {
      const response = await request(app.getHttpServer())
        .get(`/posts?${query}`)
        .expect(200);
      return (response.body as { items: { id: string }[] }).items.map(
        (post) => post.id,
      );
    };
    const stored = (id: string) => posts.find((post) => post.id === id);
    // Extra community-1 posts, newest first: post-a is the newest.
    const addPosts = (...ids: string[]) =>
      ids.forEach((id, index) =>
        posts.push({
          id,
          title: id,
          content: 'Body',
          type: 'text',
          author_id: 'user-2',
          community_id: 'community-1',
          created_at: new Date(Date.UTC(2026, 9, 30 - index)),
          pinned_at: null,
          pinned_by: null,
        }),
      );

    afterEach(() => {
      expect(openConnections).toBe(0);
    });

    it.each([
      ['the community creator', 'creator-token', 'creator-1'],
      ['a community moderator', 'moderator-token', 'user-mod'],
    ])(
      'lets %s pin with 200, the post DTO and pinned_by from the token',
      async (_who, token, userId) => {
        const response = await as(token).pin('post-1').expect(200);

        expect(response.body).toEqual({
          id: 'post-1',
          title: 'First',
          content: 'First body',
          type: 'text',
          author_id: 'user-1',
          community_id: 'community-1',
          created_at: '2026-10-22T08:00:00.000Z',
          pinned_at: '2026-11-01T08:01:00.000Z',
          pinned_by: userId,
          score: 0,
        });
        expect(JSON.stringify(response.body)).not.toMatch(
          /email|password_hash/,
        );
        expect(moderationLog).toEqual([
          {
            community_id: 'community-1',
            actor_id: userId,
            action: 'post_pinned',
            target_type: 'post',
            target_id: 'post-1',
          },
        ]);
      },
    );

    it.each([
      ["the post's own author", 'valid-token'],
      ['another member', 'fixture-author-token'],
      ['a moderator of a different community', 'other-moderator-token'],
    ])('answers 403 to %s and pins nothing', async (_who, token) => {
      await as(token).pin('post-1').expect(403);

      expect(stored('post-1')).toMatchObject({
        pinned_at: null,
        pinned_by: null,
      });
      expect(moderationLog).toEqual([]);
    });

    it('answers 401 without a token, 404 for an unknown post and 400 for a malformed ID', async () => {
      await as().pin('post-1').expect(401);
      const missing = await as('moderator-token').pin('unknown').expect(404);
      expect((missing.body as { message: string }).message).toBe(
        'Post not found',
      );
      await as('moderator-token').pin('post-1%27%20OR%201%3D1').expect(400);
      expect(moderationLog).toEqual([]);
    });

    it('is idempotent: a repeated pin answers 200 with the original pinned_at', async () => {
      const first = await as('moderator-token').pin('post-1').expect(200);
      const second = await as('creator-token').pin('post-1').expect(200);

      expect(second.body).toEqual(first.body);
      expect((second.body as { pinned_by: string }).pinned_by).toBe('user-mod');
      expect(moderationLog).toHaveLength(1);
    });

    it('answers 409 beyond the cap of 5 and pins nothing', async () => {
      addPosts('post-a', 'post-b', 'post-c', 'post-d');
      for (const id of ['post-1', 'post-a', 'post-b', 'post-c', 'post-d']) {
        await as('moderator-token').pin(id).expect(200);
      }

      const refused = await as('moderator-token').pin('post-2').expect(409);

      expect((refused.body as { message: string }).message).toBe(
        'A community can have at most 5 pinned posts',
      );
      expect(stored('post-2')?.pinned_at).toBeNull();
      expect(moderationLog).toHaveLength(5);
      // The cap is per community.
      await as('other-moderator-token').pin('post-3').expect(200);
    });

    it('answers 409 for a post removed by a moderator', async () => {
      posts = posts.map((post) =>
        post.id === 'post-1' ? { ...post, removed_at: new Date() } : post,
      );

      await as('moderator-token').pin('post-1').expect(409);
      expect(moderationLog).toEqual([]);
    });

    it('answers 404 for a post in a deleted community', async () => {
      deletedCommunities.add('community-1');

      await as('creator-token').pin('post-1').expect(404);
      await as('creator-token').unpin('post-1').expect(404);
    });

    it('keeps the post unpinned when the moderation log cannot be written', async () => {
      failModerationLog = true;

      await as('moderator-token').pin('post-1').expect(500);

      expect(stored('post-1')).toMatchObject({
        pinned_at: null,
        pinned_by: null,
      });
      expect(moderationLog).toEqual([]);
    });

    it('unpins with 204, clearing both columns and logging post_unpinned', async () => {
      await as('moderator-token').pin('post-1').expect(200);

      const response = await as('creator-token').unpin('post-1').expect(204);

      expect(response.body).toEqual({});
      expect(stored('post-1')).toMatchObject({
        pinned_at: null,
        pinned_by: null,
      });
      expect(moderationLog.map((entry) => entry.action)).toEqual([
        'post_pinned',
        'post_unpinned',
      ]);
      expect(moderationLog[1]).toMatchObject({
        actor_id: 'creator-1',
        target_id: 'post-1',
      });
    });

    it('answers 204 for an unpinned post, logging nothing, and 404 for an unknown one', async () => {
      await as('moderator-token').unpin('post-1').expect(204);
      await as('moderator-token').unpin('unknown').expect(404);
      await as('moderator-token').unpin('post-1%27%20OR%201%3D1').expect(400);
      expect(moderationLog).toEqual([]);
    });

    it('refuses unpinning to the author, other members and other moderators', async () => {
      await as('moderator-token').pin('post-1').expect(200);

      await as().unpin('post-1').expect(401);
      for (const token of [
        'valid-token',
        'fixture-author-token',
        'other-moderator-token',
      ]) {
        await as(token).unpin('post-1').expect(403);
      }
      expect(stored('post-1')?.pinned_by).toBe('user-mod');
    });

    it('keeps the pin when the unpin cannot be logged', async () => {
      await as('moderator-token').pin('post-1').expect(200);
      failModerationLog = true;

      await as('moderator-token').unpin('post-1').expect(500);

      expect(stored('post-1')?.pinned_by).toBe('user-mod');
      expect(moderationLog).toHaveLength(1);
    });

    it('lists pins first in a community listing, and drops them back on unpin', async () => {
      expect(await listIds('community_id=community-1')).toEqual([
        'post-2',
        'post-1',
      ]);

      await as('moderator-token').pin('post-1').expect(200);
      const pinned = await request(app.getHttpServer())
        .get('/posts?community_id=community-1')
        .expect(200);
      const body = pinned.body as {
        items: Record<string, unknown>[];
        total: number;
      };
      expect(body.items.map((post) => post.id)).toEqual(['post-1', 'post-2']);
      expect(body.total).toBe(2);
      expect(body.items[0]).toMatchObject({
        pinned_at: '2026-11-01T08:01:00.000Z',
        pinned_by: 'user-mod',
      });
      expect(body.items[1]).toMatchObject({ pinned_at: null, pinned_by: null });
      expect(JSON.stringify(body)).not.toMatch(/email|password_hash/);

      await as('moderator-token').unpin('post-1').expect(204);
      expect(await listIds('community_id=community-1')).toEqual([
        'post-2',
        'post-1',
      ]);
    });

    it('does not float pins in the unfiltered feed, which keeps its previous order', async () => {
      const before = await listIds('limit=100');

      await as('moderator-token').pin('post-1').expect(200);
      await as('other-moderator-token').pin('post-3').expect(200);

      expect(await listIds('limit=100')).toEqual(before);
      expect(before.indexOf('post-3')).toBeGreaterThan(
        before.indexOf('post-1'),
      );
    });

    it('pages stably across a boundary inside the pinned set', async () => {
      addPosts('post-a', 'post-b', 'post-c');
      // Pinned in this order, so post-c (pinned last) leads.
      for (const id of ['post-1', 'post-b', 'post-c']) {
        await as('moderator-token').pin(id).expect(200);
      }
      const expected = ['post-c', 'post-b', 'post-1', 'post-a', 'post-2'];
      expect(await listIds('community_id=community-1&limit=100')).toEqual(
        expected,
      );

      const pages: string[] = [];
      for (const page of [1, 2, 3]) {
        pages.push(
          ...(await listIds(`community_id=community-1&limit=2&page=${page}`)),
        );
      }
      expect(pages).toEqual(expected);
    });
  });

  describe('scores', () => {
    const scoreQueries = () =>
      queryCalls.filter(({ sql }) =>
        sql.startsWith('SELECT target_id, SUM(value) AS score FROM votes'),
      );

    beforeEach(() => {
      votes.push(
        { user_id: 'u1', target_type: 'post', target_id: 'post-1', value: 1 },
        { user_id: 'u2', target_type: 'post', target_id: 'post-1', value: 1 },
        { user_id: 'u3', target_type: 'post', target_id: 'post-2', value: -1 },
        // Same id, other target type: never counted for the post.
        {
          user_id: 'u1',
          target_type: 'comment',
          target_id: 'post-3',
          value: 1,
        },
      );
    });

    it('puts score on every listed post, 0 when unvoted, from one grouped query per page', async () => {
      const response = await request(app.getHttpServer())
        .get('/posts')
        .expect(200);
      const body = response.body as { items: { id: string; score: number }[] };
      expect(
        Object.fromEntries(body.items.map((post) => [post.id, post.score])),
      ).toEqual({ 'post-1': 2, 'post-2': -1, 'post-3': 0 });
      expect(scoreQueries()).toHaveLength(1);
      expect(scoreQueries()[0].values).toEqual([
        'post',
        ...body.items.map((post) => post.id),
      ]);
    });

    it('puts score on a single post and on a pinned post', async () => {
      await request(app.getHttpServer())
        .get('/posts/post-1')
        .expect(200)
        .expect(({ body }) => expect(body).toMatchObject({ score: 2 }));
      const pinned = await request(app.getHttpServer())
        .post('/posts/post-2/pin')
        .set('Authorization', 'Bearer creator-token')
        .expect(200);
      expect(pinned.body).toMatchObject({ id: 'post-2', score: -1 });
    });

    it('answers a new post with score 0 without querying votes', async () => {
      const created = await request(app.getHttpServer())
        .post('/posts')
        .set('Authorization', 'Bearer valid-token')
        .send({
          title: 'Fresh',
          content: 'Body',
          type: 'text',
          community_id: 'community-1',
        })
        .expect(201);
      expect(created.body).toMatchObject({ score: 0 });
      expect(scoreQueries()).toHaveLength(0);
    });
  });
});
