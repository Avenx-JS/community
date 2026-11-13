import { POSTING_COMMUNITY_SQL } from '../src/posts/posts.service';
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
import { answerSavedFlags, type FakeSave } from './fakes/saved-posts';
import { REMOVED_CONTENT_REVIEWER_SQL } from '../src/common/removed-content';

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
  removed_by?: string | null;
  removal_reason?: string | null;
  locked_at?: Date | null;
  locked_by?: string | null;
  edited_at?: Date | null;
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
  // Versions an edit replaced (migration 039).
  let revisionWrites: unknown[][];
  let votes: FakeVote[];
  let saves: FakeSave[];
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let notifications: TestNotification[];
  let failNotificationWrite: boolean;
  let rules: RulesStore;
  let openConnections: number;
  let deletedCommunities: Set<string>;
  let suspendedCommunities: Set<string>;
  // "community:user" pairs with a permanent ban.
  let bans: Set<string>;
  let moderationLog: TestModerationEntry[];
  let failModerationLog: boolean;
  let pinClock: number;
  // The database clock of UTC_TIMESTAMP() in an edit.
  const editClock = '2026-11-05T12:00:00.000Z';
  // The database clock of UTC_TIMESTAMP() in a removal.
  const removeClock = '2026-11-07T10:00:00.000Z';
  // users.role = 'admin'.
  const platformAdmins = new Set(['platform-admin']);
  // The database clock of UTC_TIMESTAMP() in a lock.
  const lockClock = '2026-11-06T09:00:00.000Z';
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
    revisionWrites = [];
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
    saves = [];
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
    bans = new Set();
    suspendedCommunities = new Set();
    moderationLog = [];
    failModerationLog = false;
    pinClock = 0;
    // A statement that excludes deleted communities does not see a post in
    // one; a statement that forgets the exclusion still does.
    const visible = (post: TestPost, sql: string) =>
      !(
        sql.includes('deleted_at IS NULL') &&
        deletedCommunities.has(post.community_id)
      ) &&
      !(
        sql.includes('suspended_at IS NULL') &&
        suspendedCommunities.has(post.community_id)
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
        // ACTIVE_COMMUNITY_BAN_STATE_SQL, bound to (community, user).
        if (sql.includes('FROM community_bans')) {
          const [community, user] = values as string[];
          return [
            bans.has(`${community}:${user}`)
              ? [
                  {
                    community_name: rules.communities.get(community)?.name,
                    expires_at: null,
                  },
                ]
              : [],
            [],
          ];
        }
        const savedAnswer = answerSavedFlags(sql, values, saves);
        if (savedAnswer) {
          return savedAnswer;
        }
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
        // The community a post goes to (migration 038): public, all post
        // types. Values: the author, the community.
        if (sql === POSTING_COMMUNITY_SQL) {
          const id = values[1] as string;
          const live = !deletedCommunities.has(id);
          return [
            communities.includes(id) && live
              ? [
                  {
                    visibility: 'public',
                    allowed_post_types: 'text,link,media',
                    member: 1,
                  },
                ]
              : [],
            [],
          ];
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
            // The ban lookup (CommunityBanPolicyService): no ban here.
            if (sql.includes('FROM community_bans')) {
              return [[], []];
            }
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
        // PATCH /posts/:id: the locking read and the dynamic update. The
        // update replaces the row object, so a rollback's snapshot restores
        // the previous version.
        if (sql.startsWith('SELECT id, author_id, type, title, content')) {
          const [id] = values as [string];
          return [
            posts
              .filter((post) => post.id === id && visible(post, sql))
              .map((post) => ({
                ...post,
                locked_at: post.locked_at ?? null,
                removed_at: post.removed_at ?? null,
              })),
            [],
          ];
        }
        if (/^UPDATE posts SET (title|content) = \?/.test(sql)) {
          const id = values[values.length - 1] as string;
          const columns = [...sql.matchAll(/(title|content) = \?/g)].map(
            (match) => match[1] as 'title' | 'content',
          );
          const changes = Object.fromEntries(
            columns.map((column, index) => [column, values[index]]),
          );
          posts = posts.map((post) =>
            post.id === id
              ? { ...post, ...changes, edited_at: new Date(editClock) }
              : post,
          );
          return [{ affectedRows: 1 }, []];
        }
        if (sql.startsWith('SELECT id, title, content, type')) {
          const [id] = values as [string];
          return [
            posts.filter((post) => post.id === id && visible(post, sql)),
            [],
          ];
        }
        if (sql.startsWith('SELECT community_id, removed_at FROM posts')) {
          const [id] = values as [string];
          return [
            posts
              .filter((post) => post.id === id && visible(post, sql))
              .map((post) => ({
                community_id: post.community_id,
                removed_at: post.removed_at ?? null,
              })),
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
                    locked_at: post.locked_at ?? null,
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
        // POST and DELETE /posts/:id/lock: the guarded update. It replaces
        // the row object, so a rollback's snapshot restores it.
        // POST /posts/:id/remove and /restore.
        if (sql.startsWith('UPDATE posts SET removed_at')) {
          const removing = sql.includes('UTC_TIMESTAMP()');
          const id = values[values.length - 1] as string;
          posts = posts.map((post) =>
            post.id === id
              ? {
                  ...post,
                  removed_at: removing ? new Date(removeClock) : null,
                  removed_by: removing ? (values[0] as string) : null,
                  removal_reason: removing
                    ? (values[1] as string | null)
                    : null,
                }
              : post,
          );
          return [{ affectedRows: 1 }, []];
        }
        if (sql === REMOVED_CONTENT_REVIEWER_SQL) {
          const [communityId, creatorId, moderatorId, adminId] =
            values as string[];
          return [
            [
              {
                can_review:
                  communityCreators.get(communityId) === creatorId ||
                  moderatorAssignments.has(`${communityId}:${moderatorId}`) ||
                  platformAdmins.has(adminId)
                    ? 1
                    : 0,
              },
            ],
            [],
          ];
        }
        if (sql.startsWith('UPDATE posts SET locked_at')) {
          const locking = sql.includes('UTC_TIMESTAMP()');
          const id = values[values.length - 1] as string;
          const target = posts.find((post) => post.id === id);
          if (!target || Boolean(target.locked_at) === locking) {
            return [{ affectedRows: 0 }, []];
          }
          posts = posts.map((post) =>
            post.id === id
              ? {
                  ...post,
                  locked_at: locking ? new Date(lockClock) : null,
                  locked_by: locking ? (values[0] as string) : null,
                }
              : post,
          );
          return [{ affectedRows: 1 }, []];
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
        // The ban lookup (CommunityBanPolicyService): no ban here.
        if (sql.includes('FROM community_bans')) {
          return [[], []];
        }
        // Media releases (migration 035): nothing to release here.
        if (
          sql.startsWith('UPDATE media SET released_at') ||
          sql === 'UPDATE users SET avatar_media_id = NULL WHERE id = ?' ||
          sql.startsWith('UPDATE communities SET icon_media_id = NULL')
        ) {
          return [{ affectedRows: 0 }, []];
        }
        // Closing the content's community reports (migration 036): none.
        if (sql.startsWith('UPDATE user_reports')) {
          return [{ affectedRows: 0 }, []];
        }
        // An edit keeps the replaced version (migration 039).
        if (sql.startsWith('INSERT INTO post_revisions')) {
          revisionWrites.push(values);
          return [{ affectedRows: 1 }, []];
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
      'admin-token': 'platform-admin',
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
              ? { kind: 'valid', emailVerified: true, userId: userIds[token] }
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
      // A statement carrying the removal filter does not list removed posts.
      const live = posts.filter(
        (post) =>
          visible(post, sql) &&
          !(sql.includes('posts.removed_at IS NULL') && post.removed_at),
      );
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
          'edited_at',
          'locked_at',
          'locked_by',
          'score',
          'saved',
          'media',
          'flair',
          'nsfw',
          'spoiler',
          'title',
          'type',
        ].sort(),
      );
      expect(response.body).not.toHaveProperty('email');
      expect(response.body).not.toHaveProperty('password_hash');
    }
    // Breaking change (migration 035): a media post takes an uploaded
    // file's media_id, never a URL; a link post is for URLs.
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'Bearer valid-token')
      .send({
        title: 'Media',
        type: 'media',
        content: 'https://example.com/image.png',
        community_id: 'community-1',
      })
      .expect(400);
    expect(
      queryCalls.filter((call) => call.sql.startsWith('INSERT INTO posts')),
    ).toHaveLength(2);
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

  it('allows only authors to delete posts', async () => {
    await request(app.getHttpServer())
      .delete('/posts/post-2')
      .set('Authorization', 'Bearer valid-token')
      .expect(403);
    expect(posts.some((post) => post.id === 'post-2')).toBe(true);

    // Breaking change: a moderator may no longer hard-delete another
    // author's post; the 403 names the reversible removal route.
    const refused = await request(app.getHttpServer())
      .delete('/posts/post-2')
      .set('Authorization', 'Bearer moderator-token')
      .expect(403);
    expect((refused.body as { message: string }).message).toBe(
      'Only the author may delete this post; moderators remove posts with POST /posts/:id/remove',
    );
    expect(posts.some((post) => post.id === 'post-2')).toBe(true);

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
    it('notifies the author when a moderator removes their post, naming no moderator and no reason', async () => {
      await request(app.getHttpServer())
        .post('/posts/post-1/remove')
        .set('Authorization', 'Bearer moderator-token')
        .send({ reason: 'Off-topic for this community' })
        .expect(200);

      // Kept, not deleted.
      expect(posts.find((post) => post.id === 'post-1')).toMatchObject({
        removed_by: 'user-mod',
      });
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
      expect(JSON.stringify(notifications)).not.toContain('Off-topic');
      expect(openConnections).toBe(0);
    });

    it('writes nothing when the author deletes their own post', async () => {
      await request(app.getHttpServer())
        .delete('/posts/post-1')
        .set('Authorization', 'Bearer valid-token')
        .expect(204);

      expect(notifications).toEqual([]);
    });

    it('rolls the removal back when the notification cannot be written', async () => {
      failNotificationWrite = true;

      await request(app.getHttpServer())
        .post('/posts/post-1/remove')
        .set('Authorization', 'Bearer moderator-token')
        .expect(500);

      expect(
        posts.find((post) => post.id === 'post-1')?.removed_at ?? null,
      ).toBeNull();
      expect(moderationLog).toEqual([]);
      expect(notifications).toEqual([]);
      expect(openConnections).toBe(0);
    });
  });

  // user-1 (valid-token) wrote post-1 in community-1 ("general") and is banned
  // there; post-3 is in community-2.
  describe('for a user banned from the community', () => {
    const user1 = () => ({
      create: (communityId: string) =>
        request(app.getHttpServer())
          .post('/posts')
          .set('Authorization', 'Bearer valid-token')
          .send({
            title: 'New',
            content: 'Body',
            type: 'text',
            community_id: communityId,
          }),
      edit: (id: string) =>
        request(app.getHttpServer())
          .patch(`/posts/${id}`)
          .set('Authorization', 'Bearer valid-token')
          .send({ title: 'Rewritten' }),
      remove: (id: string) =>
        request(app.getHttpServer())
          .delete(`/posts/${id}`)
          .set('Authorization', 'Bearer valid-token'),
      get: (path: string) =>
        request(app.getHttpServer())
          .get(path)
          .set('Authorization', 'Bearer valid-token'),
    });
    const banned = { reason: 'community_banned', community: 'general' };

    beforeEach(() => {
      bans.add('community-1:user-1');
    });

    it('refuses a post with the payload, writing nothing', async () => {
      const before = posts.length;
      const refused = await user1().create('community-1').expect(403);
      expect(refused.body).toEqual(banned);
      expect(posts).toHaveLength(before);
      expect(notifications).toEqual([]);
      expect(openConnections).toBe(0);
    });

    it('reports the ban rather than unaccepted rules', async () => {
      rules.publish('community-1');
      expect((await user1().create('community-1').expect(403)).body).toEqual(
        banned,
      );
    });

    it('answers an unknown community with 404, not 403', async () => {
      await user1().create('no-such-community').expect(404);
    });

    it('is scoped to the one community', async () => {
      await user1().create('community-2').expect(201);
    });

    // Editing publishes new content; deleting only removes.
    it('refuses editing their own post, and lets them delete it', async () => {
      expect((await user1().edit('post-1').expect(403)).body).toEqual(banned);
      expect(posts.find((post) => post.id === 'post-1')?.title).toBe('First');
      await user1().remove('post-1').expect(204);
    });

    it('still lets them read the community’s posts', async () => {
      await user1().get('/posts?community_id=community-1').expect(200);
      await user1().get('/posts/post-2').expect(200);
    });

    it('lets them post again once the ban is lifted', async () => {
      bans.clear();
      await user1().create('community-1').expect(201);
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

    it('lets authors delete, moderators remove, and anyone read, without accepting', async () => {
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
      await as('moderator-token').post('/posts/post-2/remove').expect(200);
      await as('moderator-token').post('/posts/post-2/restore').expect(200);

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
          edited_at: null,
          locked_at: null,
          locked_by: null,
          pinned_by: userId,
          score: 0,
          saved: false,
          media: null,
          flair: null,
          nsfw: false,
          spoiler: false,
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

  describe('PATCH /posts/:id', () => {
    const patch = (path: string, body: object, token?: string) => {
      const call = request(app.getHttpServer()).patch(path).send(body);
      return token ? call.set('Authorization', `Bearer ${token}`) : call;
    };
    const stored = (id: string) => posts.find((post) => post.id === id);
    const edits = () =>
      queryCalls.filter(({ sql }) =>
        /^UPDATE posts SET (title|content)/.test(sql),
      );
    const addLinkPost = (id: string, type: 'link' | 'media') =>
      posts.push({
        id,
        title: 'A link',
        content: 'https://example.com/original',
        type,
        author_id: 'user-1',
        community_id: 'community-1',
        created_at: new Date('2026-10-20T08:00:00.000Z'),
        pinned_at: null,
        pinned_by: null,
      });

    afterEach(() => {
      expect(openConnections).toBe(0);
    });

    it('lets the author edit the title alone, keeping content, id and created_at', async () => {
      const response = await patch(
        '/posts/post-1',
        { title: '  Corrected  ' },
        'valid-token',
      ).expect(200);
      expect(response.body).toEqual({
        id: 'post-1',
        title: 'Corrected',
        content: 'First body',
        type: 'text',
        author_id: 'user-1',
        community_id: 'community-1',
        created_at: '2026-10-22T08:00:00.000Z',
        pinned_at: null,
        pinned_by: null,
        edited_at: editClock,
        locked_at: null,
        locked_by: null,
        score: 0,
        saved: false,
        media: null,
        flair: null,
        nsfw: false,
        spoiler: false,
      });
      expect(stored('post-1')).toMatchObject({
        title: 'Corrected',
        content: 'First body',
      });
      // The replaced version is kept (migration 039), in the same write.
      expect(revisionWrites).toHaveLength(1);
      expect(revisionWrites[0].slice(1, 3)).toEqual(['post-1', 'First']);
    });

    it('lets the author edit the content alone', async () => {
      await patch('/posts/post-1', { content: 'New body' }, 'valid-token')
        .expect(200)
        .expect(({ body }) =>
          expect(body).toMatchObject({ title: 'First', content: 'New body' }),
        );
    });

    it('preserves the id, created_at and votes of the post', async () => {
      votes.push(
        { user_id: 'u1', target_type: 'post', target_id: 'post-1', value: 1 },
        { user_id: 'u2', target_type: 'post', target_id: 'post-1', value: 1 },
      );
      const before = { ...stored('post-1') };
      const response = await patch(
        '/posts/post-1',
        { title: 'T', content: 'C' },
        'valid-token',
      ).expect(200);
      expect(response.body).toMatchObject({
        id: before.id,
        created_at: before.created_at?.toISOString(),
        score: 2,
      });
      expect(votes).toHaveLength(2);
      // An edit is an UPDATE, never a delete and re-insert.
      expect(
        queryCalls.some(({ sql }) =>
          /^(DELETE FROM posts|INSERT INTO posts)/.test(sql),
        ),
      ).toBe(false);
    });

    it('answers identical values with 200 and leaves edited_at null', async () => {
      const response = await patch(
        '/posts/post-1',
        { title: ' First ', content: 'First body' },
        'valid-token',
      ).expect(200);
      expect(response.body).toMatchObject({ edited_at: null });
      expect(edits()).toHaveLength(0);
    });

    it.each([
      [{}, 'an empty body'],
      [{ title: '' }, 'an empty title'],
      [{ content: '   ' }, 'blank content'],
      [{ title: 'x'.repeat(301) }, 'a long title'],
      [{ title: 'T', type: 'link' }, 'type'],
      [{ title: 'T', community_id: 'community-2' }, 'community_id'],
      [{ title: 'T', author_id: 'user-2' }, 'author_id'],
      [{ title: 'T', created_at: '2020-01-01T00:00:00Z' }, 'created_at'],
      [{ title: 'T', pinned_at: null }, 'an unknown property'],
    ] as [object, string][])(
      'refuses %o (%s) with 400 and writes nothing',
      async (body) => {
        await patch('/posts/post-1', body, 'valid-token').expect(400);
        expect(edits()).toHaveLength(0);
        expect(stored('post-1')?.title).toBe('First');
      },
    );

    it.each([
      ['moderator-token', 'a community moderator'],
      ['creator-token', 'the community creator'],
      ['other-moderator-token', 'an unrelated user'],
    ])('answers %s (%s) with 403', async (token) => {
      const response = await patch(
        '/posts/post-1',
        { title: 'Hijacked' },
        token,
      ).expect(403);
      expect((response.body as { message: string }).message).toBe(
        'Only the author may edit this post',
      );
      expect(stored('post-1')?.title).toBe('First');
    });

    it('lets the same moderator remove the post they may not edit', async () => {
      await patch('/posts/post-1', { title: 'x' }, 'moderator-token').expect(
        403,
      );
      await request(app.getHttpServer())
        .post('/posts/post-1/remove')
        .set('Authorization', 'Bearer moderator-token')
        .expect(200);
    });

    it('answers 401 without a token, 404 for an unknown post and 400 for a malformed id', async () => {
      await patch('/posts/post-1', { title: 'T' }).expect(401);
      await patch('/posts/missing', { title: 'T' }, 'valid-token').expect(404);
      await patch(
        '/posts/post-1%27%20OR%201%3D1',
        { title: 'T' },
        'valid-token',
      ).expect(400);
    });

    it('answers 409 for a post removed by moderation', async () => {
      stored('post-1')!.removed_at = new Date('2026-11-01T00:00:00.000Z');
      await patch('/posts/post-1', { title: 'Rewrite' }, 'valid-token').expect(
        409,
      );
      expect(edits()).toHaveLength(0);
    });

    it('answers 404 in a deleted or suspended community', async () => {
      deletedCommunities.add('community-1');
      await patch('/posts/post-1', { title: 'T' }, 'valid-token').expect(404);
      deletedCommunities.clear();
      suspendedCommunities.add('community-1');
      await patch('/posts/post-1', { title: 'T' }, 'valid-token').expect(404);
      expect(edits()).toHaveLength(0);
    });

    it('lets the author edit their own locked post', async () => {
      stored('post-1')!.locked_at = new Date('2026-11-01T00:00:00.000Z');
      await patch('/posts/post-1', { content: 'Fixed' }, 'valid-token').expect(
        200,
      );
    });

    it('succeeds for an author who has not accepted the current rules', async () => {
      rules.publish('community-1');
      await patch('/posts/post-1', { title: 'Fixed' }, 'valid-token').expect(
        200,
      );
      // The same author may no longer create a post there.
      await request(app.getHttpServer())
        .post('/posts')
        .set('Authorization', 'Bearer valid-token')
        .send({
          title: 'New',
          content: 'Body',
          type: 'text',
          community_id: 'community-1',
        })
        .expect(403);
    });

    describe.each(['link', 'media'] as const)(
      "a %s post's content, validated against its stored type",
      (type) => {
        const id = `${type}-post`;
        beforeEach(() => {
          addLinkPost(id, type);
        });

        it('accepts an HTTP(S) URL', async () => {
          await patch(
            `/posts/${id}`,
            { content: 'https://example.org/new' },
            'valid-token',
          ).expect(200);
        });

        it.each([
          'plain text, not a URL',
          'https://user:pass@example.com/',
          'ftp://example.com/file',
          'javascript:alert(1)',
          'https://example.com/a\\b',
          'https://example.com/\u0007',
        ])('refuses %j with 400 and writes nothing', async (content) => {
          await patch(`/posts/${id}`, { content }, 'valid-token').expect(400);
          expect(edits()).toHaveLength(0);
          expect(stored(id)?.content).toBe('https://example.com/original');
        });

        it('accepts a title-only edit without a URL check', async () => {
          await patch(
            `/posts/${id}`,
            { title: 'Renamed' },
            'valid-token',
          ).expect(200);
        });
      },
    );

    it('accepts arbitrary text on a text post', async () => {
      await patch(
        '/posts/post-1',
        { content: 'Not a URL, and fine for a text post' },
        'valid-token',
      ).expect(200);
    });
  });

  describe('POST and DELETE /posts/:id/lock', () => {
    const as = (token?: string) => {
      const server = () => request(app.getHttpServer());
      const auth = (call: request.Test) =>
        token ? call.set('Authorization', `Bearer ${token}`) : call;
      return {
        lock: (id: string) => auth(server().post(`/posts/${id}/lock`)),
        unlock: (id: string) => auth(server().delete(`/posts/${id}/lock`)),
      };
    };
    const stored = (id: string) => posts.find((post) => post.id === id);
    const lockWrites = () =>
      queryCalls.filter(({ sql }) =>
        sql.startsWith('UPDATE posts SET locked_at'),
      );

    afterEach(() => {
      expect(openConnections).toBe(0);
    });

    it.each([
      ['creator-token', 'creator-1'],
      ['moderator-token', 'user-mod'],
    ])(
      'lets %s lock with 200 and the post DTO, from the database clock and the token, and unlock with 204',
      async (token, actor) => {
        const locked = await as(token).lock('post-1').expect(200);
        expect(locked.body).toMatchObject({
          id: 'post-1',
          title: 'First',
          locked_at: lockClock,
          locked_by: actor,
        });
        expect(lockWrites()[0].values).toEqual([actor, 'post-1']);

        await as(token).unlock('post-1').expect(204);
        expect(stored('post-1')).toMatchObject({
          locked_at: null,
          locked_by: null,
        });
        expect(moderationLog).toEqual([
          {
            community_id: 'community-1',
            actor_id: actor,
            action: 'post_locked',
            target_type: 'post',
            target_id: 'post-1',
          },
          {
            community_id: 'community-1',
            actor_id: actor,
            action: 'post_unlocked',
            target_type: 'post',
            target_id: 'post-1',
          },
        ]);
      },
    );

    it('is idempotent: a repeated lock keeps locked_at, a repeated unlock is 204, each logged once', async () => {
      const first = await as('moderator-token').lock('post-1').expect(200);
      const second = await as('creator-token').lock('post-1').expect(200);
      expect(second.body).toMatchObject({
        locked_at: (first.body as { locked_at: string }).locked_at,
        locked_by: 'user-mod',
      });
      await as('moderator-token').unlock('post-1').expect(204);
      await as('moderator-token').unlock('post-1').expect(204);
      expect(moderationLog.map((entry) => entry.action)).toEqual([
        'post_locked',
        'post_unlocked',
      ]);
    });

    it('renders a lock by a since-deleted moderator with locked_by null', async () => {
      Object.assign(stored('post-1')!, {
        locked_at: new Date('2026-11-01T00:00:00.000Z'),
        locked_by: null,
      });
      await request(app.getHttpServer())
        .get('/posts/post-1')
        .expect(200)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            locked_at: '2026-11-01T00:00:00.000Z',
            locked_by: null,
          }),
        );
    });

    it.each([
      ['valid-token', "the post's own author, who does not moderate"],
      ['other-moderator-token', 'a moderator of another community'],
      ['fixture-author-token', 'an unrelated user'],
    ])('answers %s (%s) with 403 on both methods', async (token) => {
      await as(token).lock('post-1').expect(403);
      await as(token).unlock('post-1').expect(403);
      expect(lockWrites()).toHaveLength(0);
      expect(moderationLog).toHaveLength(0);
    });

    it('answers 401, 404 and 400 on both methods', async () => {
      await as().lock('post-1').expect(401);
      await as().unlock('post-1').expect(401);
      await as('moderator-token').lock('missing').expect(404);
      await as('moderator-token').unlock('missing').expect(404);
      await as('moderator-token').lock('post-1%27%20OR%201%3D1').expect(400);
      await as('moderator-token').unlock('post-1%27%20OR%201%3D1').expect(400);
    });

    it('answers 409 for a removed post on both methods', async () => {
      stored('post-1')!.removed_at = new Date('2026-11-01T00:00:00.000Z');
      await as('moderator-token').lock('post-1').expect(409);
      await as('moderator-token').unlock('post-1').expect(409);
      expect(lockWrites()).toHaveLength(0);
    });

    it('rolls the lock back when the log entry cannot be written', async () => {
      failModerationLog = true;
      await as('moderator-token').lock('post-1').expect(500);
      expect(stored('post-1')?.locked_at ?? null).toBeNull();
    });

    it('rolls the unlock back when the log entry cannot be written', async () => {
      await as('moderator-token').lock('post-1').expect(200);
      failModerationLog = true;
      await as('moderator-token').unlock('post-1').expect(500);
      expect(stored('post-1')?.locked_at).not.toBeNull();
    });

    it('leaves a locked post editable and deletable by its author', async () => {
      await as('moderator-token').lock('post-1').expect(200);
      await request(app.getHttpServer())
        .patch('/posts/post-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ title: 'Still mine' })
        .expect(200)
        .expect(({ body }) =>
          expect(body).toMatchObject({
            title: 'Still mine',
            locked_by: 'user-mod',
          }),
        );
      await request(app.getHttpServer())
        .delete('/posts/post-1')
        .set('Authorization', 'Bearer valid-token')
        .expect(204);
    });
  });

  describe('moderative removal', () => {
    const as = (token?: string) => {
      const server = () => request(app.getHttpServer());
      const auth = (call: request.Test) =>
        token ? call.set('Authorization', `Bearer ${token}`) : call;
      return {
        remove: (id: string, body: object = {}) =>
          auth(server().post(`/posts/${id}/remove`)).send(body),
        restore: (id: string) => auth(server().post(`/posts/${id}/restore`)),
        get: (path: string) => auth(server().get(path)),
      };
    };
    const stored = (id: string) => posts.find((post) => post.id === id);
    const removalWrites = () =>
      queryCalls.filter(({ sql }) =>
        sql.startsWith('UPDATE posts SET removed_at'),
      );
    const listedIds = async (path: string) =>
      (
        (await as().get(path).expect(200)).body as {
          items: { id: string }[];
        }
      ).items.map((post) => post.id);

    afterEach(() => {
      expect(openConnections).toBe(0);
    });

    it.each([
      ['creator-token', 'creator-1'],
      ['moderator-token', 'user-mod'],
    ])(
      'lets %s remove with 200, from the database clock and the token, keeping the row',
      async (token, actor) => {
        const response = await as(token)
          .remove('post-1', { reason: '  Spam  ' })
          .expect(200);
        expect(response.body).toMatchObject({
          id: 'post-1',
          title: 'First',
          removed: true,
          removed_at: removeClock,
          removed_by: actor,
          removal_reason: 'Spam',
        });
        expect(stored('post-1')).toBeDefined();
        expect(
          queryCalls.some(({ sql }) => sql.startsWith('DELETE FROM posts')),
        ).toBe(false);
        expect(moderationLog).toEqual([
          {
            community_id: 'community-1',
            actor_id: actor,
            action: 'post_removed',
            target_type: 'post',
            target_id: 'post-1',
          },
        ]);
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({
          type: 'content_removed',
          actor_id: null,
        });
      },
    );

    it.each([
      ['valid-token', 'the author, who does not moderate'],
      ['fixture-author-token', 'an unrelated user'],
      ['other-moderator-token', 'a moderator of another community'],
    ])('answers %s (%s) with 403 on remove and restore', async (token) => {
      await as(token).remove('post-1').expect(403);
      stored('post-1')!.removed_at = new Date('2026-11-01T00:00:00.000Z');
      await as(token).restore('post-1').expect(403);
      expect(removalWrites()).toHaveLength(0);
      expect(moderationLog).toEqual([]);
    });

    it('points the author at DELETE', async () => {
      const response = await as('valid-token').remove('post-1').expect(403);
      expect((response.body as { message: string }).message).toBe(
        'Moderators remove posts; authors delete their own with DELETE /posts/:id',
      );
    });

    it('answers 401, 404, 400 and 409 on remove and restore', async () => {
      await as().remove('post-1').expect(401);
      await as().restore('post-1').expect(401);
      await as('moderator-token').remove('missing').expect(404);
      await as('moderator-token').restore('missing').expect(404);
      await as('moderator-token').remove('post-1%27%20OR%201%3D1').expect(400);
      await as('moderator-token').restore('post-1%27%20OR%201%3D1').expect(400);
      // Restoring a post that is not removed.
      await as('moderator-token').restore('post-1').expect(409);
      await as('moderator-token').remove('post-1').expect(200);
      // Removing it twice.
      await as('moderator-token').remove('post-1').expect(409);
      expect(moderationLog).toHaveLength(1);
    });

    it.each([
      [{ reason: 'x'.repeat(2001) }, 'an over-long reason'],
      [{ reason: 'bad\u0007reason' }, 'a control character'],
      [{ reason: '' }, 'an empty reason'],
      [{ removed_by: 'someone' }, 'an unknown property'],
    ] as [object, string][])(
      'refuses %o (%s) with 400 and writes nothing',
      async (body) => {
        await as('moderator-token').remove('post-1', body).expect(400);
        expect(removalWrites()).toHaveLength(0);
      },
    );

    it('hides a removed post from every public read, and restores it', async () => {
      await as('moderator-token').remove('post-1').expect(200);

      await as().get('/posts/post-1').expect(404);
      expect(await listedIds('/posts')).not.toContain('post-1');
      expect(await listedIds('/posts?community_id=community-1')).not.toContain(
        'post-1',
      );
      await as().get('/posts/post-1/comments').expect(404);

      const restored = await as('moderator-token')
        .restore('post-1')
        .expect(200);
      expect(restored.body).not.toHaveProperty('removed');
      expect(stored('post-1')).toMatchObject({
        removed_at: null,
        removed_by: null,
        removal_reason: null,
      });
      await as().get('/posts/post-1').expect(200);
      expect(await listedIds('/posts')).toContain('post-1');
      expect(moderationLog.map((entry) => entry.action)).toEqual([
        'post_removed',
        'post_restored',
      ]);
      // No restore notification.
      expect(notifications).toHaveLength(1);
    });

    describe('GET /posts/:id on a removed post', () => {
      beforeEach(() => {
        Object.assign(stored('post-1')!, {
          removed_at: new Date('2026-11-01T00:00:00.000Z'),
          removed_by: null,
          removal_reason: 'Spam',
        });
      });

      it.each([
        [undefined, 'an anonymous caller'],
        ['valid-token', 'the author'],
        ['fixture-author-token', 'an unrelated member'],
        ['other-moderator-token', 'a moderator of another community'],
        ['not-a-token', 'a caller with an invalid token'],
      ] as [string | undefined, string][])(
        'answers %s (%s) with 404',
        async (token) => {
          const response = await as(token).get('/posts/post-1').expect(404);
          expect(JSON.stringify(response.body)).not.toMatch(/Spam|First body/);
        },
      );

      it.each([
        ['moderator-token', 'a community moderator'],
        ['creator-token', 'the community creator'],
        ['admin-token', 'a platform admin'],
      ])(
        'shows %s (%s) the full post and its removal state, removed_by null for a deleted moderator',
        async (token) => {
          const response = await as(token).get('/posts/post-1').expect(200);
          expect(response.body).toMatchObject({
            id: 'post-1',
            title: 'First',
            content: 'First body',
            removed: true,
            removed_at: '2026-11-01T00:00:00.000Z',
            removed_by: null,
            removal_reason: 'Spam',
          });
        },
      );

      it('returns the same post to a reviewer as before removal, plus only the removal fields', async () => {
        const reviewer = (
          await as('moderator-token').get('/posts/post-1').expect(200)
        ).body as Record<string, unknown>;
        stored('post-1')!.removed_at = null;
        const ordinary = (await as().get('/posts/post-1').expect(200))
          .body as Record<string, unknown>;
        const {
          removed,
          removed_at,
          removed_by,
          removal_reason,
          removed_by_admin,
          ...rest
        } = reviewer;
        expect([
          removed,
          removed_at,
          removed_by,
          removal_reason,
          removed_by_admin,
        ]).toEqual([true, '2026-11-01T00:00:00.000Z', null, 'Spam', false]);
        expect(rest).toEqual(ordinary);
      });
    });

    it('lets the author still delete their own visible post: the DELETE author path is unchanged', async () => {
      await request(app.getHttpServer())
        .delete('/posts/post-1')
        .set('Authorization', 'Bearer valid-token')
        .expect(204, '');
      expect(stored('post-1')).toBeUndefined();
      expect(notifications).toEqual([]);
    });

    it('refuses editing a removed post with 409', async () => {
      await as('moderator-token').remove('post-1').expect(200);
      await request(app.getHttpServer())
        .patch('/posts/post-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ title: 'Rewrite' })
        .expect(409);
    });
  });
});
