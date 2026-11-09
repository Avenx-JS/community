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
import { answerVoteScores, type FakeVote } from './fakes/vote-scores';
import { REMOVED_CONTENT_REVIEWER_SQL } from '../src/common/removed-content';

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
  removed_at?: Date | null;
  locked_at?: Date | null;
  edited_at?: Date | null;
  locked_by?: string | null;
  removed_by?: string | null;
  removal_reason?: string | null;
}

interface ListedComment {
  id: string;
  post_id: string;
  parent_id: string | null;
  reply_count: number;
  [key: string]: unknown;
}

interface CommentNode {
  id: string;
  score: number;
  replies: CommentNode[];
}

interface CommentPage {
  items: ListedComment[];
  page: number;
  limit: number;
  total: number;
  sort: string;
}

describe('Comment endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let comments: TestComment[];
  let votes: FakeVote[];
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let notifications: TestNotification[];
  let failNotificationWrite: boolean;
  let openConnections: number;
  let rules: RulesStore;
  let deletedCommunities: Set<string>;
  let suspendedCommunities: Set<string>;
  // "blocker:blocked" pairs, read by the block lookup.
  let blocks: Set<string>;
  let lockedPosts: Set<string>;
  let removedPosts: Set<string>;
  let ancestryReads: number;
  let moderationLog: Array<{
    community_id: string;
    actor_id: string;
    action: string;
    target_type: string;
    target_id: string;
  }>;
  let failModerationLog: boolean;
  // The database clock of UTC_TIMESTAMP() in a removal.
  const removeClock = '2026-11-07T10:00:00.000Z';
  // users.role = 'admin'.
  const platformAdmins = new Set(['platform-admin']);
  let reviewerChecks: number;
  // The database clock of UTC_TIMESTAMP() in a lock.
  const lockClock = '2026-11-06T09:00:00.000Z';
  // The database clock of UTC_TIMESTAMP() in an edit.
  const editClock = '2026-11-05T12:00:00.000Z';
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
  const moderatorAssignments = new Set([
    'community-1:user-mod',
    'community-2:user-other-mod',
  ]);

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
    votes = [];
    queryCalls = [];
    notifications = [];
    failNotificationWrite = false;
    openConnections = 0;
    deletedCommunities = new Set();
    suspendedCommunities = new Set();
    blocks = new Set();
    lockedPosts = new Set();
    removedPosts = new Set();
    ancestryReads = 0;
    reviewerChecks = 0;
    moderationLog = [];
    failModerationLog = false;
    // A statement that excludes deleted communities does not see a post in
    // one; a statement that forgets the exclusion still does.
    const visiblePost = (postId: string, sql: string) =>
      postIds.includes(postId) &&
      !(
        sql.includes('deleted_at IS NULL') &&
        deletedCommunities.has(postCommunities.get(postId) as string)
      );
    // No community has published rules unless a test publishes some.
    rules = createRulesStore({
      'community-1': { name: 'general', creator_id: 'creator-1' },
      'community-2': { name: 'other', creator_id: 'creator-2' },
    });

    // The flat listings: WHERE parent_id = ? (replies) or WHERE post_id = ?
    // AND parent_id IS NULL (top level), honouring the removal filter only
    // when the statement carries it.
    const listedComments = (sql: string, key: string) =>
      comments.filter(
        (comment) =>
          (sql.includes('WHERE parent_id = ?')
            ? comment.parent_id === key
            : comment.post_id === key && comment.parent_id === null) &&
          !(sql.includes('removed_at IS NULL') && comment.removed_at),
      );
    const chronological = (left: TestComment, right: TestComment) =>
      left.created_at.getTime() - right.created_at.getTime() ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

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
        // PATCH /comments/:id: the locking read (with its post's state),
        // the update and the re-read. The update replaces the row object, so
        // a rollback's snapshot restores the previous version.
        if (
          sql.startsWith('SELECT comments.id, comments.author_id') &&
          sql.includes('post_removed_at')
        ) {
          const [id] = values as [string];
          const comment = comments.find((entry) => entry.id === id);
          const suspended =
            comment !== undefined &&
            sql.includes('suspended_at IS NULL') &&
            suspendedCommunities.has(
              postCommunities.get(comment.post_id) as string,
            );
          return [
            comment && visiblePost(comment.post_id, sql) && !suspended
              ? [
                  {
                    ...comment,
                    locked_at: comment.locked_at ?? null,
                    removed_at: comment.removed_at ?? null,
                    post_locked_at: lockedPosts.has(comment.post_id)
                      ? new Date('2026-11-01T00:00:00.000Z')
                      : null,
                    post_removed_at: removedPosts.has(comment.post_id)
                      ? new Date('2026-11-01T00:00:00.000Z')
                      : null,
                  },
                ]
              : [],
            [],
          ];
        }
        if (
          sql ===
          'UPDATE comments SET content = ?, edited_at = UTC_TIMESTAMP() WHERE id = ?'
        ) {
          const [content, id] = values as [string, string];
          comments = comments.map((comment) =>
            comment.id === id
              ? { ...comment, content, edited_at: new Date(editClock) }
              : comment,
          );
          return [{ affectedRows: 1 }, []];
        }
        if (
          sql.startsWith(
            'SELECT id, post_id, parent_id, author_id, content, created_at, edited_at, locked_at, locked_by FROM comments WHERE id = ?',
          )
        ) {
          const [id] = values as [string];
          return [
            comments
              .filter((comment) => comment.id === id)
              .map((comment) => ({
                ...comment,
                edited_at: comment.edited_at ?? null,
              })),
            [],
          ];
        }
        // POST and DELETE /comments/:id/lock: the locking read with the
        // moderation check, the guarded update and the log write.
        if (sql.startsWith('SELECT comments.id, posts.community_id')) {
          const [creatorId, moderatorId, id] = values as string[];
          const comment = comments.find((entry) => entry.id === id);
          if (!comment || !visiblePost(comment.post_id, sql)) {
            return [[], []];
          }
          const communityId = postCommunities.get(comment.post_id) as string;
          return [
            [
              {
                id,
                community_id: communityId,
                locked_at: comment.locked_at ?? null,
                removed_at: comment.removed_at ?? null,
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
        if (sql.startsWith('UPDATE comments SET locked_at')) {
          const locking = sql.includes('UTC_TIMESTAMP()');
          const id = values[values.length - 1] as string;
          const target = comments.find((comment) => comment.id === id);
          if (!target || Boolean(target.locked_at) === locking) {
            return [{ affectedRows: 0 }, []];
          }
          const lockedBy = locking ? (values[0] as string) : null;
          comments = comments.map((comment) =>
            comment.id === id
              ? {
                  ...comment,
                  locked_at: locking ? new Date(lockClock) : null,
                  locked_by: lockedBy,
                }
              : comment,
          );
          return [{ affectedRows: 1 }, []];
        }
        if (sql === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
          return [[{ username: `name-of-${values[0] as string}` }], []];
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
        if (sql.startsWith('SELECT comments.id, comments.post_id')) {
          const [creatorId, moderatorId, id] = values as string[];
          const comment = comments.find((entry) => entry.id === id);
          if (!comment || !visiblePost(comment.post_id, sql)) {
            return [[], []];
          }
          const communityId = postCommunities.get(comment.post_id) as string;
          return [
            [
              {
                ...comment,
                community_id: communityId,
                removed_at: comment.removed_at ?? null,
                post_removed_at: removedPosts.has(comment.post_id)
                  ? new Date('2026-11-01T00:00:00.000Z')
                  : null,
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
        if (sql.startsWith('UPDATE comments SET removed_at')) {
          const removing = sql.includes('UTC_TIMESTAMP()');
          const id = values[values.length - 1] as string;
          comments = comments.map((comment) =>
            comment.id === id
              ? {
                  ...comment,
                  removed_at: removing ? new Date(removeClock) : null,
                  removed_by: removing ? (values[0] as string) : null,
                  removal_reason: removing
                    ? (values[1] as string | null)
                    : null,
                }
              : comment,
          );
          return [{ affectedRows: 1 }, []];
        }
        if (
          sql.startsWith(
            'SELECT removed_at, removed_by, removal_reason FROM comments',
          )
        ) {
          return [comments.filter((comment) => comment.id === values[0]), []];
        }
        if (sql === REMOVED_CONTENT_REVIEWER_SQL) {
          const [communityId, creatorId, moderatorId, adminId] =
            values as string[];
          reviewerChecks += 1;
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
        if (sql.startsWith('SELECT comments.id FROM comments')) {
          const [id] = values as [string];
          const comment = comments.find((entry) => entry.id === id);
          return [
            comment &&
            visiblePost(comment.post_id, sql) &&
            !(
              sql.includes('posts.removed_at IS NULL') &&
              removedPosts.has(comment.post_id)
            )
              ? [{ id }]
              : [],
            [],
          ];
        }
        if (
          sql.startsWith(
            'SELECT id, post_id, parent_id, author_id, content, created_at, edited_at, locked_at, locked_by FROM comments',
          )
        ) {
          const [key, limit, offset] = values as [string, number, number];
          const sorted = listedComments(sql, key).sort(chronological);
          if (sql.includes('ORDER BY created_at DESC, id DESC')) {
            sorted.reverse();
          }
          return [
            sorted
              .slice(offset, offset + limit)
              .map((comment) => ({ ...comment, edited_at: null })),
            [],
          ];
        }
        if (sql.startsWith('SELECT COUNT(*) AS total FROM comments')) {
          const [key] = values as [string];
          return [[{ total: listedComments(sql, key).length }], []];
        }
        if (sql.startsWith('SELECT parent_id, COUNT(*) AS reply_count')) {
          const ids = values as string[];
          const counts = new Map<string, number>();
          for (const comment of comments) {
            if (
              comment.parent_id !== null &&
              ids.includes(comment.parent_id) &&
              !(sql.includes('removed_at IS NULL') && comment.removed_at)
            ) {
              counts.set(
                comment.parent_id,
                (counts.get(comment.parent_id) ?? 0) + 1,
              );
            }
          }
          return [
            [...counts].map(([parent_id, reply_count]) => ({
              parent_id,
              reply_count,
            })),
            [],
          ];
        }
        if (sql.startsWith('SELECT id, author_id, community_id, title')) {
          const [postId] = values as [string];
          return [
            visiblePost(postId, sql)
              ? [
                  {
                    id: postId,
                    author_id: postAuthors.get(postId),
                    community_id: postCommunities.get(postId),
                    title: `Title of ${postId}`,
                    locked_at: lockedPosts.has(postId)
                      ? new Date('2026-11-01T00:00:00.000Z')
                      : null,
                    removed_at: removedPosts.has(postId)
                      ? new Date('2026-11-01T00:00:00.000Z')
                      : null,
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
        if (sql.startsWith('SELECT community_id, removed_at FROM posts')) {
          const [postId] = values as [string];
          return [
            visiblePost(postId, sql)
              ? [
                  {
                    community_id: postCommunities.get(postId),
                    removed_at: removedPosts.has(postId)
                      ? new Date('2026-11-01T00:00:00.000Z')
                      : null,
                  },
                ]
              : [],
            [],
          ];
        }
        if (sql.startsWith('SELECT id FROM posts')) {
          const [postId] = values as [string];
          const hidden =
            sql.includes('posts.removed_at IS NULL') &&
            removedPosts.has(postId);
          return [
            visiblePost(postId, sql) && !hidden ? [{ id: postId }] : [],
            [],
          ];
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
        // PARENT_WITH_ANCESTRY_SQL: walks parent_id from the parent upwards,
        // at most `bound` levels, as the recursive CTE does. Like the real
        // aggregate it answers one row, of NULLs for an unknown parent.
        if (sql.startsWith('WITH RECURSIVE ancestors')) {
          const [id, postId, bound] = values as [string, string, number];
          const parent = comments.find(
            (comment) => comment.id === id && comment.post_id === postId,
          );
          if (!parent) {
            return [
              [
                {
                  id: null,
                  author_id: null,
                  thread_locked: null,
                  depth_exceeded: null,
                },
              ],
              [],
            ];
          }
          let current: TestComment | undefined = parent;
          let depth = 1;
          let locked = false;
          let exceeded = false;
          while (current) {
            locked ||= Boolean(current.locked_at);
            if (depth === bound) {
              exceeded = current.parent_id !== null;
              break;
            }
            const parentId: string | null = current.parent_id;
            current = comments.find((comment) => comment.id === parentId);
            depth += 1;
          }
          ancestryReads += 1;
          return [
            [
              {
                id: parent.id,
                author_id: parent.author_id,
                parent_removed: parent.removed_at ? 1 : 0,
                thread_locked: locked ? 1 : 0,
                depth_exceeded: exceeded ? 1 : 0,
              },
            ],
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
          if (!comment || !visiblePost(comment.post_id, sql)) {
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
        if (sql.includes('FROM user_blocks')) {
          const [a, b] = values as string[];
          const blocked = blocks.has(`${a}:${b}`) || blocks.has(`${b}:${a}`);
          return [[{ blocked: blocked ? 1 : 0 }], []];
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
      'creator-token': 'creator-1',
      'admin-token': 'platform-admin',
      'other-moderator-token': 'user-other-mod',
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
        'edited_at',
        'locked_at',
        'locked_by',
        'score',
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

  // Breaking change: a moderator may no longer hard-delete another author's
  // comment; the 403 names the reversible removal route.
  it('refuses a moderator delete with 403, in their community or another', async () => {
    const refused = await request(app.getHttpServer())
      .delete('/comments/reply-1')
      .set('Authorization', 'Bearer moderator-token')
      .expect(403);
    expect((refused.body as { message: string }).message).toBe(
      'Only the author may delete this comment; moderators remove comments with POST /comments/:id/remove',
    );
    expect(comments.some((comment) => comment.id === 'reply-1')).toBe(true);

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

    it('notifies only the author of a comment a moderator removes, naming no moderator and no reason', async () => {
      await request(app.getHttpServer())
        .post('/comments/reply-1/remove')
        .set('Authorization', 'Bearer moderator-token')
        .send({ reason: 'Personal attack' })
        .expect(200);

      // Kept, not deleted.
      expect(
        comments.find((comment) => comment.id === 'reply-1'),
      ).toMatchObject({
        removed_by: 'user-mod',
        removal_reason: 'Personal attack',
      });
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
      expect(JSON.stringify(inbox.body)).not.toContain('Personal attack');
      expect(JSON.stringify(notifications)).not.toContain('Personal attack');
    });

    it('writes nothing when the author deletes their own comment', async () => {
      await request(app.getHttpServer())
        .delete('/comments/root-1')
        .set('Authorization', 'Bearer valid-token')
        .expect(204);

      expect(notifications).toEqual([]);
    });

    it('rolls the removal back when the notification cannot be written', async () => {
      failNotificationWrite = true;

      await request(app.getHttpServer())
        .post('/comments/reply-1/remove')
        .set('Authorization', 'Bearer moderator-token')
        .expect(500);

      expect(
        comments.find((comment) => comment.id === 'reply-1')?.removed_at ??
          null,
      ).toBeNull();
      expect(moderationLog).toEqual([]);
      expect(comments.some((comment) => comment.id === 'nested-reply')).toBe(
        true,
      );
      expect(openConnections).toBe(0);
    });
  });

  // user-2 wrote post-1 and reply-1; user-1 wrote post-2, root-1 and
  // nested-reply; user-3 wrote root-2. A block in either direction refuses
  // directed interaction and changes nothing else.
  describe('between blocked users', () => {
    const as = (token: string) => {
      const server = () => request(app.getHttpServer());
      const auth = (call: request.Test) =>
        call.set('Authorization', `Bearer ${token}`);
      return {
        comment: (postId: string, parentId?: string) =>
          auth(server().post(`/posts/${postId}/comments`)).send({
            content: 'Hello',
            ...(parentId ? { parent_id: parentId } : {}),
          }),
        remove: (id: string) =>
          auth(server().post(`/comments/${id}/remove`)).send({}),
        lock: (id: string) => auth(server().post(`/comments/${id}/lock`)),
        deleteOwn: (id: string) => auth(server().delete(`/comments/${id}`)),
      };
    };
    const user1 = as('valid-token');
    const user2 = as('post-author-token');
    const moderator = as('moderator-token');
    const inserts = () =>
      queryCalls.filter(({ sql }) => sql.startsWith('INSERT INTO comments'));
    const refusedFor = async (call: request.Test) => {
      const response = await call.expect(403);
      expect(response.body).toEqual({ reason: 'user_blocked' });
      return response.text;
    };

    it.each([
      ['user-2 blocked user-1', 'user-2:user-1'],
      ['user-1 blocked user-2', 'user-1:user-2'],
    ])(
      'refuses comments both ways, with one payload, when %s',
      async (_name, pair) => {
        blocks.add(pair);
        const before = comments.length;
        // user-1 on user-2's post, and user-2 on user-1's post.
        const one = await refusedFor(user1.comment('post-1'));
        const other = await refusedFor(user2.comment('post-2'));
        expect(one).toBe(other);
        expect(one).not.toMatch(/user-1|user-2|blocker|blocked_by/);
        expect(comments).toHaveLength(before);
        expect(inserts()).toHaveLength(0);
        expect(notifications).toEqual([]);
        expect(openConnections).toBe(0);
      },
    );

    it('is byte-identical whichever way the block runs', async () => {
      blocks.add('user-2:user-1');
      const blocked = await refusedFor(user1.comment('post-1'));
      blocks.clear();
      blocks.add('user-1:user-2');
      const blocker = await refusedFor(user1.comment('post-1'));
      expect(blocked).toBe(blocker);
    });

    // A reply is directed at the parent comment's author, not the post's.
    it('refuses a reply to the blocked user’s comment, and allows one to a third user’s on their post', async () => {
      blocks.add('user-2:user-1');
      await refusedFor(user1.comment('post-1', 'reply-1'));
      await user1.comment('post-1', 'root-2').expect(201);
      expect(notifications.map((row) => row.recipient_id)).toEqual(['user-3']);
    });

    it('allows a reply to a third user’s comment even where the post author is blocked', async () => {
      blocks.add('user-1:user-2');
      await user1.comment('post-1', 'root-2').expect(201);
    });

    // After the 404s, so the check never confirms that a post exists.
    it('answers an unknown post with 404, not 403', async () => {
      blocks.add('user-2:user-1');
      await user1.comment('no-such-post').expect(404);
      await user1.comment('post-1', 'no-such-parent').expect(404);
    });

    it('lets a blocked user’s comments stay in the shared thread', async () => {
      blocks.add('user-1:user-2');
      const thread = (
        await request(app.getHttpServer())
          .get('/posts/post-1/comments')
          .set('Authorization', 'Bearer valid-token')
          .expect(200)
      ).text;
      expect(thread).toContain('"reply-1"');
      expect(thread).toContain('"author_id":"user-2"');
    });

    it('lets either side delete their own comment', async () => {
      blocks.add('user-1:user-2');
      blocks.add('user-2:user-1');
      await user1.deleteOwn('root-2').expect(403);
      await user1.deleteOwn('nested-reply').expect(204);
      await user2.deleteOwn('other-post-comment').expect(204);
    });

    // Blocking a moderator must not let anyone block their way out of
    // moderation, and a moderator's own block changes nothing either.
    it('never stops a moderator acting on a user who blocked them, or whom they blocked', async () => {
      blocks.add('user-1:user-mod');
      blocks.add('user-mod:user-1');
      await moderator.remove('root-1').expect(200);
      await moderator.lock('nested-reply').expect(200);
      expect(
        comments.find((comment) => comment.id === 'root-1')?.removed_at,
      ).toBeTruthy();
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

    it('lets authors delete, moderators remove, and anyone read, without accepting', async () => {
      rules.publish('community-1');
      const check = jest.spyOn(
        app.get(CommunityRuleAcceptanceService),
        'assertAcceptedOrThrow',
      );

      await as('valid-token').get('/posts/post-1/comments').expect(200);
      await as('valid-token').delete('/comments/root-1').expect(204);
      await as('moderator-token').post('/comments/root-2/remove').expect(200);
      await as('moderator-token').post('/comments/root-2/restore').expect(200);

      expect(check).not.toHaveBeenCalled();
    });
  });

  describe('in a deleted community', () => {
    const send = (
      method: 'get' | 'post' | 'delete',
      path: string,
      token = 'valid-token',
    ) =>
      request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${token}`);

    beforeEach(() => {
      deletedCommunities.add('community-1');
    });

    it('answers 404 for the thread of a post in it', async () => {
      const response = await send('get', '/posts/post-1/comments').expect(404);
      expect((response.body as { message: string }).message).toBe(
        'Post not found',
      );
    });

    it('refuses a new comment or reply with 404 and writes nothing', async () => {
      await send('post', '/posts/post-1/comments')
        .send({ content: 'Anyone here?' })
        .expect(404);
      await send('post', '/posts/post-1/comments')
        .send({ content: 'Reply', parent_id: 'root-1' })
        .expect(404);

      expect(comments).toHaveLength(5);
      expect(notifications).toEqual([]);
      expect(openConnections).toBe(0);
    });

    it('answers 404 to deleting its comments, for authors and moderators alike', async () => {
      await send('delete', '/comments/root-1').expect(404);
      await send('delete', '/comments/root-2', 'moderator-token').expect(404);

      expect(comments.map((comment) => comment.id)).toEqual([
        'root-1',
        'reply-1',
        'nested-reply',
        'root-2',
        'other-post-comment',
      ]);
      expect(
        queryCalls.some(({ sql }) => sql.startsWith('DELETE FROM comments')),
      ).toBe(false);
    });

    it('leaves threads in other communities readable', async () => {
      await send('get', '/posts/post-2/comments').expect(200);
    });
  });

  describe('paginated listings', () => {
    const get = (path: string) => request(app.getHttpServer()).get(path);
    const pageOf = async (path: string) =>
      (await get(path).expect(200)).body as CommentPage;
    const ids = (page: CommentPage) => page.items.map((item) => item.id);

    // Every comment reachable from the post: page the roots, then page each
    // comment's replies, depth first, limit 100.
    async function crawl(postId: string, sort = 'oldest') {
      const seen: string[] = [];
      const pageAll = async (path: string) => {
        const items: ListedComment[] = [];
        for (let page = 1; ; page += 1) {
          const body = await pageOf(
            `${path}?page=${page}&limit=100&sort=${sort}`,
          );
          items.push(...body.items);
          if (page * 100 >= body.total) {
            return items;
          }
        }
      };
      const visit = async (items: ListedComment[]) => {
        for (const item of items) {
          seen.push(item.id);
          if (item.reply_count > 0) {
            await visit(await pageAll(`/comments/${item.id}/replies`));
          }
        }
      };
      await visit(await pageAll(`/posts/${postId}/comments/top-level`));
      return seen;
    }

    it('serves both routes without a token, with the envelope and flat items', async () => {
      const replies = await pageOf('/comments/root-1/replies');
      expect(replies).toEqual({
        items: [
          {
            id: 'reply-1',
            post_id: 'post-1',
            parent_id: 'root-1',
            author_id: 'user-2',
            content: 'Reply',
            created_at: '2026-10-22T08:01:00.000Z',
            edited_at: null,
            locked_at: null,
            locked_by: null,
            reply_count: 1,
            score: 0,
          },
        ],
        page: 1,
        limit: 20,
        total: 1,
        sort: 'oldest',
      });

      const roots = await pageOf('/posts/post-1/comments/top-level');
      // Equal created_at: the id tiebreaker decides.
      expect(ids(roots)).toEqual(['root-1', 'root-2']);
      expect(roots.items.map((item) => item.reply_count)).toEqual([1, 0]);
      expect(roots.items.every((item) => item.parent_id === null)).toBe(true);
      expect(roots.total).toBe(2);

      for (const item of [...replies.items, ...roots.items]) {
        expect(item).not.toHaveProperty('replies');
        expect(item).not.toHaveProperty('email');
      }
    });

    it('returns only direct children, never a grandchild', async () => {
      const replies = await pageOf('/comments/root-1/replies');
      expect(ids(replies)).toEqual(['reply-1']);
      expect(ids(await pageOf('/comments/reply-1/replies'))).toEqual([
        'nested-reply',
      ]);
    });

    it('answers a comment without replies, and a post without roots, with an empty page', async () => {
      const empty = { items: [], page: 1, limit: 20, total: 0, sort: 'oldest' };
      expect(await pageOf('/comments/nested-reply/replies')).toEqual(empty);
      comments = comments.filter((comment) => comment.post_id !== 'post-2');
      expect(await pageOf('/posts/post-2/comments/top-level')).toEqual(empty);
    });

    it.each([
      ['/comments/missing/replies', 404, 'Comment not found'],
      ['/posts/missing/comments/top-level', 404, 'Post not found'],
      ['/comments/root-1%27%20OR%201%3D1/replies', 400, undefined],
      ['/posts/post-1%27%20OR%201%3D1/comments/top-level', 400, undefined],
    ])('answers %s with %i', async (path, status, message) => {
      const response = await get(path).expect(status);
      if (message) {
        expect((response.body as { message: string }).message).toBe(message);
      }
    });

    it.each([
      'page=0',
      'page=10001',
      'page=1.5',
      'limit=0',
      'limit=101',
      'sort=top',
      'sort=created_at%20DESC',
      'depth=2',
      'unexpected=1',
    ])('rejects ?%s on both routes with 400', async (query) => {
      await get(`/comments/root-1/replies?${query}`).expect(400);
      await get(`/posts/post-1/comments/top-level?${query}`).expect(400);
    });

    it('honours the bounds at their limits', async () => {
      await get('/comments/root-1/replies?page=10000&limit=100').expect(200);
      await get(
        '/posts/post-1/comments/top-level?page=1&limit=1&sort=new',
      ).expect(200);
    });

    it('pages every reply exactly once in both directions, with the id tiebreaker', async () => {
      // 25 replies, created_at repeating in fives.
      for (let index = 0; index < 25; index += 1) {
        comments.push({
          id: `many-${String(index).padStart(2, '0')}`,
          post_id: 'post-1',
          author_id: 'user-1',
          parent_id: 'root-2',
          content: `Reply ${index}`,
          created_at: new Date(Date.UTC(2026, 9, 23, 8, Math.floor(index / 5))),
        });
      }
      for (const sort of ['oldest', 'new']) {
        const seen: string[] = [];
        for (let page = 1; page <= 4; page += 1) {
          const body = await pageOf(
            `/comments/root-2/replies?page=${page}&limit=7&sort=${sort}`,
          );
          expect(body.total).toBe(25);
          seen.push(...ids(body));
        }
        const expected = Array.from(
          { length: 25 },
          (_, index) => `many-${String(index).padStart(2, '0')}`,
        );
        expect(seen).toEqual(sort === 'new' ? expected.reverse() : expected);
      }
    });

    it('omits removed comments but keeps their replies readable', async () => {
      const reply = comments.find((comment) => comment.id === 'reply-1');
      reply!.removed_at = new Date('2026-10-24T08:00:00.000Z');

      const replies = await pageOf('/comments/root-1/replies');
      expect(replies).toMatchObject({ items: [], total: 0 });
      const roots = await pageOf('/posts/post-1/comments/top-level');
      expect(roots.items[0]).toMatchObject({ id: 'root-1', reply_count: 0 });

      // The removed comment is hidden, the discussion beneath it is not.
      expect(ids(await pageOf('/comments/reply-1/replies'))).toEqual([
        'nested-reply',
      ]);

      const root = comments.find((comment) => comment.id === 'root-2');
      root!.removed_at = new Date('2026-10-24T08:00:00.000Z');
      expect(ids(await pageOf('/posts/post-1/comments/top-level'))).toEqual([
        'root-1',
      ]);
    });

    it('answers 404 on both routes for content of a deleted community', async () => {
      deletedCommunities.add('community-1');
      await get('/comments/root-1/replies').expect(404);
      await get('/comments/reply-1/replies').expect(404);
      await get('/posts/post-1/comments/top-level').expect(404);
      await get('/comments/other-post-comment/replies').expect(200);
      await get('/posts/post-2/comments/top-level').expect(200);
    });

    it('walks a deeply nested chain one level per request', async () => {
      let parent = 'nested-reply';
      for (let depth = 0; depth < 40; depth += 1) {
        const id = `deep-${depth}`;
        comments.push({
          id,
          post_id: 'post-1',
          author_id: 'user-1',
          parent_id: parent,
          content: `Depth ${depth}`,
          created_at: new Date(Date.UTC(2026, 9, 25, 8, depth)),
        });
        parent = id;
      }

      let current = 'nested-reply';
      for (let depth = 0; depth < 40; depth += 1) {
        const body = await pageOf(`/comments/${current}/replies`);
        expect(ids(body)).toEqual([`deep-${depth}`]);
        expect(body.items[0].reply_count).toBe(depth < 39 ? 1 : 0);
        current = `deep-${depth}`;
      }
      expect(await pageOf(`/comments/${current}/replies`)).toMatchObject({
        items: [],
        total: 0,
      });
      // The tree route still nests the whole chain below the ceiling.
      await get('/posts/post-1/comments').expect(200);
    });

    describe('a thread over the ceiling', () => {
      // 700 more comments on post-1: 50 roots, each with 3 replies, each of
      // those with 3 replies; all share created_at in tens.
      beforeEach(() => {
        let sequence = 0;
        const add = (parentId: string | null) => {
          const id = `big-${String(sequence).padStart(4, '0')}`;
          comments.push({
            id,
            post_id: 'post-1',
            author_id: 'user-1',
            parent_id: parentId,
            content: `Comment ${sequence}`,
            created_at: new Date(
              Date.UTC(2026, 9, 26, 8, Math.floor(sequence / 10)),
            ),
          });
          sequence += 1;
          return id;
        };
        for (let root = 0; root < 50; root += 1) {
          const rootId = add(null);
          for (let child = 0; child < 3; child += 1) {
            const childId = add(rootId);
            for (let grandchild = 0; grandchild < 3; grandchild += 1) {
              add(childId);
            }
          }
        }
      });

      it('still answers the tree route with 413, naming the paginated routes', async () => {
        const response = await get('/posts/post-1/comments').expect(413);
        expect((response.body as { message: string }).message).toBe(
          'Comment threads are limited to 500 comments; page through ' +
            'GET /posts/:postId/comments/top-level and ' +
            'GET /comments/:id/replies instead',
        );
      });

      it.each(['oldest', 'new'])(
        'reaches every comment exactly once through the two routes (sort=%s)',
        async (sort) => {
          const expected = comments
            .filter((comment) => comment.post_id === 'post-1')
            .map((comment) => comment.id);
          expect(expected.length).toBeGreaterThan(500);

          const seen = await crawl('post-1', sort);

          expect(seen).toHaveLength(expected.length);
          expect(new Set(seen).size).toBe(expected.length);
          expect([...seen].sort()).toEqual([...expected].sort());
        },
      );
    });
  });

  describe('scores', () => {
    const scoreQueries = () =>
      queryCalls.filter(({ sql }) =>
        sql.startsWith('SELECT target_id, SUM(value) AS score FROM votes'),
      );

    beforeEach(() => {
      votes.push(
        {
          user_id: 'u1',
          target_type: 'comment',
          target_id: 'root-1',
          value: 1,
        },
        {
          user_id: 'u2',
          target_type: 'comment',
          target_id: 'root-1',
          value: 1,
        },
        {
          user_id: 'u1',
          target_type: 'comment',
          target_id: 'reply-1',
          value: -1,
        },
        // Same id, other target type: never counted for the comment.
        { user_id: 'u1', target_type: 'post', target_id: 'root-2', value: 1 },
      );
    });

    it('scores every node of the tree, 0 when unvoted, from one grouped query', async () => {
      const response = await request(app.getHttpServer())
        .get('/posts/post-1/comments')
        .expect(200);
      const [root1, root2] = (response.body as { comments: CommentNode[] })
        .comments;
      expect(root1).toMatchObject({ id: 'root-1', score: 2 });
      expect(root1.replies[0]).toMatchObject({ id: 'reply-1', score: -1 });
      expect(root1.replies[0].replies[0]).toMatchObject({
        id: 'nested-reply',
        score: 0,
      });
      expect(root2).toMatchObject({ id: 'root-2', score: 0 });
      expect(scoreQueries()).toHaveLength(1);
      expect(scoreQueries()[0].values).toHaveLength(5);
    });

    it('scores the flat listings with one grouped query per page', async () => {
      const roots = await request(app.getHttpServer())
        .get('/posts/post-1/comments/top-level')
        .expect(200);
      expect(
        (roots.body as CommentPage).items.map((item) => [item.id, item.score]),
      ).toEqual([
        ['root-1', 2],
        ['root-2', 0],
      ]);
      const replies = await request(app.getHttpServer())
        .get('/comments/root-1/replies')
        .expect(200);
      expect((replies.body as CommentPage).items[0]).toMatchObject({
        id: 'reply-1',
        score: -1,
      });
      expect(scoreQueries()).toHaveLength(2);
    });

    it('answers a new comment with score 0 without querying votes', async () => {
      const created = await request(app.getHttpServer())
        .post('/posts/post-1/comments')
        .set('Authorization', 'Bearer valid-token')
        .send({ content: 'Fresh' })
        .expect(201);
      expect(created.body).toMatchObject({ score: 0, replies: [] });
      expect(scoreQueries()).toHaveLength(0);
    });
  });

  describe('PATCH /comments/:id', () => {
    const patch = (path: string, body: object, token?: string) => {
      const call = request(app.getHttpServer()).patch(path).send(body);
      return token ? call.set('Authorization', `Bearer ${token}`) : call;
    };
    const stored = (id: string) =>
      comments.find((comment) => comment.id === id);
    const edits = () =>
      queryCalls.filter(({ sql }) => sql.startsWith('UPDATE comments'));

    afterEach(() => {
      expect(openConnections).toBe(0);
    });

    it('lets the author edit the content, keeping its place in the thread', async () => {
      const response = await patch(
        '/comments/root-1',
        { content: '  Corrected  ' },
        'valid-token',
      ).expect(200);
      expect(response.body).toEqual({
        id: 'root-1',
        post_id: 'post-1',
        parent_id: null,
        author_id: 'user-1',
        content: 'Corrected',
        created_at: '2026-10-22T08:00:00.000Z',
        edited_at: editClock,
        locked_at: null,
        locked_by: null,
        reply_count: 1,
        score: 0,
      });

      // The reply chain beneath it is untouched.
      const thread = await request(app.getHttpServer())
        .get('/posts/post-1/comments')
        .expect(200);
      expect(
        (thread.body as { comments: CommentNode[] }).comments[0],
      ).toMatchObject({
        id: 'root-1',
        edited_at: editClock,
        replies: [{ id: 'reply-1', replies: [{ id: 'nested-reply' }] }],
      });
    });

    it('answers identical content with 200 and leaves edited_at null', async () => {
      await patch(
        '/comments/root-1',
        { content: 'Root comment' },
        'valid-token',
      )
        .expect(200)
        .expect(({ body }) => expect(body).toMatchObject({ edited_at: null }));
      expect(edits()).toHaveLength(0);
    });

    it.each([
      [{}, 'an empty body'],
      [{ content: '  ' }, 'blank content'],
      [{ content: 'x'.repeat(16384) }, 'long content'],
      [{ content: 'Moved', parent_id: 'root-2' }, 'parent_id'],
      [{ content: 'Moved', post_id: 'post-2' }, 'post_id'],
      [{ content: 'Mine', author_id: 'user-2' }, 'author_id'],
    ] as [object, string][])(
      'refuses %o (%s) with 400 and writes nothing',
      async (body) => {
        await patch('/comments/root-1', body, 'valid-token').expect(400);
        expect(edits()).toHaveLength(0);
        expect(stored('root-1')).toMatchObject({
          content: 'Root comment',
          parent_id: null,
        });
      },
    );

    it.each([
      ['moderator-token', 'a community moderator'],
      ['creator-token', 'the community creator'],
      ['post-author-token', 'an unrelated user'],
    ])('answers %s (%s) with 403', async (token) => {
      const response = await patch(
        '/comments/root-1',
        { content: 'Hijacked' },
        token,
      ).expect(403);
      expect((response.body as { message: string }).message).toBe(
        'Only the author may edit this comment',
      );
      expect(stored('root-1')?.content).toBe('Root comment');
    });

    it('lets the same moderator remove the comment they may not edit', async () => {
      await patch(
        '/comments/root-1',
        { content: 'x' },
        'moderator-token',
      ).expect(403);
      await request(app.getHttpServer())
        .post('/comments/root-1/remove')
        .set('Authorization', 'Bearer moderator-token')
        .expect(200);
    });

    it('answers 401 without a token, 404 for an unknown comment and 400 for a malformed id', async () => {
      await patch('/comments/root-1', { content: 'x' }).expect(401);
      await patch('/comments/missing', { content: 'x' }, 'valid-token').expect(
        404,
      );
      await patch(
        '/comments/root-1%27%20OR%201%3D1',
        { content: 'x' },
        'valid-token',
      ).expect(400);
    });

    it.each([
      [
        'the comment is removed',
        () => {
          stored('root-1')!.removed_at = new Date('2026-11-01T00:00:00.000Z');
        },
      ],
      ['its post is removed', () => removedPosts.add('post-1')],
    ] as [string, () => void][])(
      'answers 409 when %s',
      async (_label, arrange) => {
        arrange();
        await patch('/comments/root-1', { content: 'x' }, 'valid-token').expect(
          409,
        );
        expect(edits()).toHaveLength(0);
      },
    );

    // A lock closes the discussion; it does not freeze what was written.
    it.each([
      [
        'the comment is locked',
        () => {
          stored('root-1')!.locked_at = new Date('2026-11-01T00:00:00.000Z');
        },
      ],
      ['its post is locked', () => lockedPosts.add('post-1')],
    ] as [string, () => void][])(
      'still lets the author edit when %s',
      async (_label, arrange) => {
        arrange();
        await patch(
          '/comments/root-1',
          { content: 'Corrected' },
          'valid-token',
        ).expect(200);
      },
    );

    it('answers 404 in a deleted or suspended community', async () => {
      deletedCommunities.add('community-1');
      await patch('/comments/root-1', { content: 'x' }, 'valid-token').expect(
        404,
      );
      deletedCommunities.clear();
      suspendedCommunities.add('community-1');
      await patch('/comments/root-1', { content: 'x' }, 'valid-token').expect(
        404,
      );
      expect(edits()).toHaveLength(0);
    });

    it('succeeds for an author who has not accepted the current rules', async () => {
      rules.publish('community-1');
      await patch(
        '/comments/root-1',
        { content: 'Fixed' },
        'valid-token',
      ).expect(200);
      // The same author may no longer reply there.
      await request(app.getHttpServer())
        .post('/posts/post-1/comments')
        .set('Authorization', 'Bearer valid-token')
        .send({ content: 'New' })
        .expect(403);
    });
  });

  describe('locking', () => {
    const as = (token?: string) => {
      const server = () => request(app.getHttpServer());
      const auth = (call: request.Test) =>
        token ? call.set('Authorization', `Bearer ${token}`) : call;
      return {
        lock: (id: string) => auth(server().post(`/comments/${id}/lock`)),
        unlock: (id: string) => auth(server().delete(`/comments/${id}/lock`)),
        reply: (parentId: string, content = 'A reply') =>
          auth(server().post('/posts/post-1/comments')).send({
            content,
            parent_id: parentId,
          }),
        comment: (postId = 'post-1') =>
          auth(server().post(`/posts/${postId}/comments`)).send({
            content: 'Top level',
          }),
        edit: (id: string) =>
          auth(server().patch(`/comments/${id}`)).send({ content: 'Fixed' }),
        remove: (id: string) => auth(server().delete(`/comments/${id}`)),
      };
    };
    const stored = (id: string) =>
      comments.find((comment) => comment.id === id);
    const inserts = () =>
      queryCalls.filter(({ sql }) => sql.startsWith('INSERT INTO comments'));
    const lockedBy = (id: string, actor = 'creator-1') => {
      comments = comments.map((comment) =>
        comment.id === id
          ? {
              ...comment,
              locked_at: new Date('2026-11-01T00:00:00.000Z'),
              locked_by: actor,
            }
          : comment,
      );
    };
    // root-1 → reply-1 → nested-reply → deep-3 → deep-4: the reply chain
    // used for the depth tests.
    const addDeepChain = () => {
      comments.push(
        {
          id: 'deep-3',
          post_id: 'post-1',
          author_id: 'user-2',
          parent_id: 'nested-reply',
          content: 'Depth 3',
          created_at: new Date('2026-10-22T08:03:00.000Z'),
        },
        {
          id: 'deep-4',
          post_id: 'post-1',
          author_id: 'user-1',
          parent_id: 'deep-3',
          content: 'Depth 4',
          created_at: new Date('2026-10-22T08:04:00.000Z'),
        },
      );
    };

    afterEach(() => {
      expect(openConnections).toBe(0);
    });

    describe('POST and DELETE /comments/:id/lock', () => {
      it.each(['moderator-token', 'creator-token'])(
        'lets %s lock with 200 and the flat comment, from the database clock and the token, and unlock with 204',
        async (token) => {
          const actor = token === 'creator-token' ? 'creator-1' : 'user-mod';
          const locked = await as(token).lock('reply-1').expect(200);
          expect(locked.body).toMatchObject({
            id: 'reply-1',
            parent_id: 'root-1',
            locked_at: lockClock,
            locked_by: actor,
            reply_count: 1,
          });
          expect(locked.body).not.toHaveProperty('replies');

          await as(token).unlock('reply-1').expect(204);
          expect(stored('reply-1')).toMatchObject({
            locked_at: null,
            locked_by: null,
          });
          expect(moderationLog).toEqual([
            {
              community_id: 'community-1',
              actor_id: actor,
              action: 'comment_locked',
              target_type: 'comment',
              target_id: 'reply-1',
            },
            {
              community_id: 'community-1',
              actor_id: actor,
              action: 'comment_unlocked',
              target_type: 'comment',
              target_id: 'reply-1',
            },
          ]);
        },
      );

      it('is idempotent: a second lock keeps locked_at and a second unlock is 204, logging once each', async () => {
        lockedBy('reply-1');
        const again = await as('moderator-token').lock('reply-1').expect(200);
        expect(again.body).toMatchObject({
          locked_at: '2026-11-01T00:00:00.000Z',
          locked_by: 'creator-1',
        });
        expect(moderationLog).toHaveLength(0);

        await as('moderator-token').unlock('reply-1').expect(204);
        await as('moderator-token').unlock('reply-1').expect(204);
        expect(moderationLog.map((entry) => entry.action)).toEqual([
          'comment_unlocked',
        ]);
      });

      it('renders a lock by a since-deleted moderator with locked_by null', async () => {
        lockedBy('reply-1', null as unknown as string);
        await as('moderator-token')
          .lock('reply-1')
          .expect(200)
          .expect(({ body }) =>
            expect(body).toMatchObject({ locked_by: null }),
          );
      });

      it.each([
        ['valid-token', "the comment's own author"],
        ['other-moderator-token', 'a moderator of another community'],
        ['post-author-token', 'an unrelated user'],
      ])('answers %s (%s) with 403 on both methods', async (token) => {
        await as(token).lock('root-1').expect(403);
        await as(token).unlock('root-1').expect(403);
        expect(stored('root-1')?.locked_at ?? null).toBeNull();
        expect(moderationLog).toHaveLength(0);
      });

      it('answers 401, 404 and 400 on both methods', async () => {
        await as().lock('root-1').expect(401);
        await as().unlock('root-1').expect(401);
        await as('moderator-token').lock('missing').expect(404);
        await as('moderator-token').unlock('missing').expect(404);
        await as('moderator-token').lock('x%27%20OR%201%3D1').expect(400);
        await as('moderator-token').unlock('x%27%20OR%201%3D1').expect(400);
      });

      it('answers 409 for a removed comment on both methods', async () => {
        stored('root-1')!.removed_at = new Date('2026-11-01T00:00:00.000Z');
        await as('moderator-token').lock('root-1').expect(409);
        await as('moderator-token').unlock('root-1').expect(409);
      });

      it('answers 404 once the community is deleted', async () => {
        deletedCommunities.add('community-1');
        await as('moderator-token').lock('root-1').expect(404);
      });

      it('rolls the lock back when the log entry cannot be written', async () => {
        failModerationLog = true;
        await as('moderator-token').lock('root-1').expect(500);
        expect(stored('root-1')?.locked_at ?? null).toBeNull();
        await as('valid-token').reply('root-1').expect(201);
      });

      it('rolls the unlock back when the log entry cannot be written', async () => {
        lockedBy('root-1');
        failModerationLog = true;
        await as('moderator-token').unlock('root-1').expect(500);
        expect(stored('root-1')?.locked_at).not.toBeNull();
      });
    });

    describe('enforcement on new comments', () => {
      it('refuses a top-level comment on a locked post, and allows it again once unlocked', async () => {
        lockedPosts.add('post-1');
        const refused = await as('valid-token').comment().expect(409);
        expect((refused.body as { message: string }).message).toBe(
          'This post is locked; it accepts no new comments',
        );
        // A reply anywhere on the locked post is refused the same way.
        await as('valid-token').reply('root-2').expect(409);
        expect(inserts()).toHaveLength(0);

        lockedPosts.delete('post-1');
        await as('valid-token').comment().expect(201);
      });

      it('refuses replies under a locked comment, then allows them after unlocking', async () => {
        await as('moderator-token').lock('root-1').expect(200);
        const refused = await as('valid-token').reply('root-1').expect(409);
        expect((refused.body as { message: string }).message).toBe(
          'A comment above this reply is locked; its thread accepts no new replies',
        );
        expect(inserts()).toHaveLength(0);

        await as('moderator-token').unlock('root-1').expect(204);
        await as('valid-token').reply('root-1').expect(201);
      });

      // A direct-parent-only check would let each of these through.
      it.each([
        ['the direct parent', 'root-1', 'root-1'],
        ['the grandparent', 'root-1', 'reply-1'],
        ['the great-grandparent', 'root-1', 'nested-reply'],
        ['the root, four levels up', 'root-1', 'deep-4'],
        ['a comment mid-chain', 'reply-1', 'deep-4'],
      ])(
        'refuses a reply when %s is locked',
        async (_label, lockedId, parentId) => {
          addDeepChain();
          lockedBy(lockedId);
          await as('valid-token').reply(parentId).expect(409);
          expect(inserts()).toHaveLength(0);
        },
      );

      it('keeps a sibling subtree and the locked comment’s ancestors open', async () => {
        addDeepChain();
        lockedBy('nested-reply');
        // Siblings of the locked subtree and its ancestors still take replies.
        await as('valid-token').reply('root-2').expect(201);
        await as('valid-token').reply('reply-1').expect(201);
        await as('valid-token').reply('root-1').expect(201);
        await as('valid-token').comment().expect(201);
        // Beneath it, nothing.
        await as('valid-token').reply('deep-3').expect(409);
        await as('valid-token').reply('deep-4').expect(409);
      });

      it.each(['moderator-token', 'creator-token'])(
        'refuses %s too: a lock binds moderators until they unlock',
        async (token) => {
          lockedBy('root-1');
          await as(token).reply('reply-1').expect(409);
          lockedPosts.add('post-1');
          await as(token).comment().expect(409);
          expect(inserts()).toHaveLength(0);
        },
      );

      it('answers 404 for an unknown post or parent before any lock is consulted', async () => {
        lockedPosts.add('post-1');
        lockedBy('root-1');
        await as('valid-token').comment('missing-post').expect(404);
        await as('valid-token').reply('unknown-parent').expect(404);
        await as('valid-token').reply('other-post-comment').expect(404);
      });

      it('answers the rule gate (403) before the lock (409)', async () => {
        rules.publish('community-1');
        lockedPosts.add('post-1');
        const response = await as('valid-token').comment().expect(403);
        expect(response.body).toMatchObject({
          reason: 'community_rules_not_accepted',
        });
      });
    });

    describe('what a lock does not affect', () => {
      it('keeps locked content readable in the tree and the flat routes, with its lock state', async () => {
        lockedBy('reply-1', 'user-mod');
        const thread = await request(app.getHttpServer())
          .get('/posts/post-1/comments')
          .expect(200);
        expect(
          (thread.body as { comments: CommentNode[] }).comments[0].replies[0],
        ).toMatchObject({
          id: 'reply-1',
          locked_at: '2026-11-01T00:00:00.000Z',
          locked_by: 'user-mod',
          replies: [{ id: 'nested-reply', locked_at: null }],
        });
        const replies = await request(app.getHttpServer())
          .get('/comments/root-1/replies')
          .expect(200);
        expect((replies.body as CommentPage).items[0]).toMatchObject({
          id: 'reply-1',
          locked_at: '2026-11-01T00:00:00.000Z',
        });
      });

      it('lets the author edit and delete their own locked comment', async () => {
        lockedBy('nested-reply');
        lockedPosts.add('post-1');
        await as('valid-token').edit('nested-reply').expect(200);
        await as('valid-token').remove('nested-reply').expect(204);
        expect(stored('nested-reply')).toBeUndefined();
      });
    });
  });

  describe('moderative removal', () => {
    const as = (token?: string) => {
      const server = () => request(app.getHttpServer());
      const auth = (call: request.Test) =>
        token ? call.set('Authorization', `Bearer ${token}`) : call;
      return {
        remove: (id: string, body: object = {}) =>
          auth(server().post(`/comments/${id}/remove`)).send(body),
        restore: (id: string) => auth(server().post(`/comments/${id}/restore`)),
        thread: (postId = 'post-1') =>
          auth(server().get(`/posts/${postId}/comments`)),
        reply: (parentId: string) =>
          auth(server().post('/posts/post-1/comments')).send({
            content: 'A reply',
            parent_id: parentId,
          }),
      };
    };
    const stored = (id: string) =>
      comments.find((comment) => comment.id === id);
    const removalWrites = () =>
      queryCalls.filter(({ sql }) =>
        sql.startsWith('UPDATE comments SET removed_at'),
      );
    const markRemoved = (id: string) => {
      comments = comments.map((comment) =>
        comment.id === id
          ? {
              ...comment,
              removed_at: new Date('2026-11-01T00:00:00.000Z'),
              removed_by: null,
              removal_reason: 'Rude',
            }
          : comment,
      );
    };
    const replyNode = async (token?: string) =>
      (
        (await as(token).thread().expect(200)).body as {
          comments: Record<string, unknown>[];
        }
      ).comments[0].replies as Record<string, unknown>[];

    afterEach(() => {
      expect(openConnections).toBe(0);
    });

    it.each([
      ['moderator-token', 'user-mod'],
      ['creator-token', 'creator-1'],
    ])(
      'lets %s remove with 200, keeping the row and its replies, and restore',
      async (token, actor) => {
        const removed = await as(token)
          .remove('reply-1', { reason: 'Rude' })
          .expect(200);
        expect(removed.body).toMatchObject({
          id: 'reply-1',
          removed: true,
          removed_at: removeClock,
          removed_by: actor,
          removal_reason: 'Rude',
        });
        expect(stored('reply-1')).toBeDefined();
        expect(stored('nested-reply')).toBeDefined();

        const restored = await as(token).restore('reply-1').expect(200);
        expect(restored.body).not.toHaveProperty('removed');
        expect(stored('reply-1')).toMatchObject({
          removed_at: null,
          removed_by: null,
          removal_reason: null,
        });
        expect(moderationLog.map((entry) => entry.action)).toEqual([
          'comment_removed',
          'comment_restored',
        ]);
        expect(notifications).toHaveLength(1);
      },
    );

    it.each([
      ['post-author-token', "the comment's author, who does not moderate"],
      ['valid-token', 'an unrelated user'],
      ['other-moderator-token', 'a moderator of another community'],
    ])('answers %s (%s) with 403 on remove and restore', async (token) => {
      await as(token).remove('reply-1').expect(403);
      markRemoved('reply-1');
      await as(token).restore('reply-1').expect(403);
      expect(removalWrites()).toHaveLength(0);
    });

    it('answers 401, 404, 400 and 409 on remove and restore', async () => {
      await as().remove('reply-1').expect(401);
      await as().restore('reply-1').expect(401);
      await as('moderator-token').remove('missing').expect(404);
      await as('moderator-token').restore('missing').expect(404);
      await as('moderator-token').remove('x%27%20OR%201%3D1').expect(400);
      await as('moderator-token').restore('x%27%20OR%201%3D1').expect(400);
      await as('moderator-token').restore('reply-1').expect(409);
      await as('moderator-token').remove('reply-1').expect(200);
      await as('moderator-token').remove('reply-1').expect(409);
      await as('moderator-token')
        .remove('root-2', { reason: 'x'.repeat(2001) })
        .expect(400);
      await as('moderator-token')
        .remove('root-2', { notify: false })
        .expect(400);
      expect(removalWrites()).toHaveLength(1);
    });

    it('refuses to restore a comment while its post is removed, naming the post', async () => {
      markRemoved('reply-1');
      removedPosts.add('post-1');
      const response = await as('moderator-token')
        .restore('reply-1')
        .expect(409);
      expect((response.body as { message: string }).message).toBe(
        'The post of this comment (post-1) is removed; restore the post first',
      );
      expect(removalWrites()).toHaveLength(0);
    });

    describe('the thread around a removed comment', () => {
      beforeEach(() => markRemoved('reply-1'));

      it.each([
        [undefined, 'an anonymous caller'],
        ['post-author-token', "the comment's own author"],
        ['valid-token', 'an unrelated member'],
        ['other-moderator-token', 'a moderator of another community'],
      ] as [string | undefined, string][])(
        'shows %s (%s) a tombstone with its replies in place',
        async (token) => {
          const [tombstone] = await replyNode(token);
          expect(tombstone).toEqual({
            id: 'reply-1',
            post_id: 'post-1',
            parent_id: 'root-1',
            created_at: '2026-10-22T08:01:00.000Z',
            removed: true,
            replies: [
              expect.objectContaining({
                id: 'nested-reply',
                content: 'Nested reply',
              }),
            ],
          });
        },
      );

      it.each([
        ['moderator-token', 'a community moderator'],
        ['creator-token', 'the community creator'],
        ['admin-token', 'a platform admin'],
      ])(
        'shows %s (%s) the comment in full with its removal state',
        async (token) => {
          const [node] = await replyNode(token);
          expect(node).toMatchObject({
            id: 'reply-1',
            author_id: 'user-2',
            content: 'Reply',
            removed: true,
            removed_at: '2026-11-01T00:00:00.000Z',
            removed_by: null,
            removal_reason: 'Rude',
            replies: [expect.objectContaining({ id: 'nested-reply' })],
          });
        },
      );

      it('differs between the two views only on the removed comment', async () => {
        const reviewer = (await as('moderator-token').thread().expect(200))
          .body as { comments: Record<string, unknown>[] };
        const ordinary = (await as().thread().expect(200)).body as {
          comments: Record<string, unknown>[];
        };
        // The other root and the nested reply are identical.
        expect(reviewer.comments[1]).toEqual(ordinary.comments[1]);
        const nestedOf = (body: typeof reviewer) =>
          (
            (body.comments[0].replies as Record<string, unknown>[])[0]
              .replies as unknown[]
          )[0];
        expect(nestedOf(reviewer)).toEqual(nestedOf(ordinary));
        expect(JSON.stringify(ordinary)).not.toMatch(/Rude|"Reply"/);
      });

      it('omits it from the flat routes for everyone, keeping its replies readable', async () => {
        const replies = await request(app.getHttpServer())
          .get('/comments/root-1/replies')
          .set('Authorization', 'Bearer moderator-token')
          .expect(200);
        expect((replies.body as CommentPage).items).toEqual([]);
        const beneath = await request(app.getHttpServer())
          .get('/comments/reply-1/replies')
          .expect(200);
        expect((beneath.body as CommentPage).items).toHaveLength(1);
      });

      it('refuses a reply to it with 409', async () => {
        const response = await as('valid-token').reply('reply-1').expect(409);
        expect((response.body as { message: string }).message).toBe(
          'The comment being replied to was removed by a moderator',
        );
        // Replies beneath it remain possible.
        await as('valid-token').reply('nested-reply').expect(201);
      });

      it('refuses its author an edit with 409', async () => {
        await request(app.getHttpServer())
          .patch('/comments/reply-1')
          .set('Authorization', 'Bearer post-author-token')
          .send({ content: 'Rewrite' })
          .expect(409);
      });

      it('makes it visible to all again once restored', async () => {
        await as('moderator-token').restore('reply-1').expect(200);
        const [node] = await replyNode();
        expect(node).toMatchObject({ id: 'reply-1', content: 'Reply' });
        expect(node).not.toHaveProperty('removed');
      });
    });

    describe('a removed post', () => {
      beforeEach(() => {
        removedPosts.add('post-1');
      });

      it('hides the thread and the flat routes from everyone but reviewers', async () => {
        await as().thread().expect(404);
        await as('valid-token').thread().expect(404);
        await as('moderator-token').thread().expect(200);
        await as('admin-token').thread().expect(200);
        await request(app.getHttpServer())
          .get('/posts/post-1/comments/top-level')
          .set('Authorization', 'Bearer moderator-token')
          .expect(404);
        await request(app.getHttpServer())
          .get('/comments/root-1/replies')
          .expect(404);
      });

      it('refuses new comments with 409', async () => {
        await request(app.getHttpServer())
          .post('/posts/post-1/comments')
          .set('Authorization', 'Bearer valid-token')
          .send({ content: 'Anyone?' })
          .expect(409);
      });
    });

    it('lets the author still delete their own comment: the DELETE author path is unchanged', async () => {
      await request(app.getHttpServer())
        .delete('/comments/root-1')
        .set('Authorization', 'Bearer valid-token')
        .expect(204, '');
      expect(stored('root-1')).toBeUndefined();
      expect(stored('nested-reply')).toBeUndefined();
      expect(notifications).toEqual([]);
    });
  });
});
