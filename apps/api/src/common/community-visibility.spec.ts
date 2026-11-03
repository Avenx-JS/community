import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { CommentsService } from '../comments/comments.service';
import { CommunitiesService } from '../communities/communities.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { CommunityRulesService } from '../communities/community-rules.service';
import { ListCommunityModerationActionsDto } from '../communities/dto/list-community-moderation-actions.dto';
import { NotificationPreferencesService } from '../communities/notification-preferences.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { CREATED_COMMUNITY_SQL } from '../users/account-deletion.service';
import { VotesService } from '../votes/votes.service';
import { activeCommunitySql } from './community-visibility';

// Community deletion is a soft delete, so it is only as real as the reads
// that honour it. Every call site that resolves a community, or content that
// belongs to one, is listed here once. Each runs against a database that
// answers every statement with no rows: a lookup must answer 404, and the
// statement that produced the 404 must carry the deleted-community
// exclusion. Listings cannot 404, so their SQL is checked directly.

// Matches both "FROM communities WHERE name = ? AND deleted_at IS NULL" and
// the aliased "WHERE c.name = ? AND c.deleted_at IS NULL".
const BY_NAME = /WHERE (?:c\.)?name = \? AND (?:c\.)?deleted_at IS NULL/;
const BY_ID = /FROM communities WHERE id = \? AND deleted_at IS NULL/;
const CONTENT = activeCommunitySql('posts.community_id');

function emptyDatabase() {
  const statements: string[] = [];
  const execute = (sql: string) => {
    statements.push(sql);
    return Promise.resolve([[], []]);
  };
  const connection = {
    execute,
    query: execute,
    beginTransaction: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
    release: () => undefined,
  };
  const pool = {
    execute,
    getConnection: () => Promise.resolve(connection),
  } as unknown as Pool;
  return { pool, statements };
}

function services(pool: Pool) {
  const ruleAcceptance = new CommunityRuleAcceptanceService(pool);
  const notifications = {
    record: jest.fn(),
    recordCommunityPost: jest.fn(),
  } as unknown as NotificationsService;
  const moderationLog = new CommunityModerationLogService(pool);
  return {
    communities: new CommunitiesService(pool, ruleAcceptance, moderationLog),
    preferences: new NotificationPreferencesService(pool),
    rules: new CommunityRulesService(pool, ruleAcceptance),
    moderationLog,
    posts: new PostsService(pool, notifications, ruleAcceptance),
    comments: new CommentsService(pool, notifications, ruleAcceptance),
    votes: new VotesService(pool, ruleAcceptance),
  };
}

type Services = ReturnType<typeof services>;

const lookups: Array<
  [string, (s: Services) => Promise<unknown>, RegExp | string]
> = [
  ['GET /communities/:name', (s) => s.communities.findOne('gone'), BY_NAME],
  [
    'PATCH /communities/:name',
    (s) => s.communities.update('gone', { description: 'x' }, 'u'),
    BY_NAME,
  ],
  [
    'DELETE /communities/:name',
    (s) => s.communities.remove('gone', 'gone', 'u'),
    BY_NAME,
  ],
  [
    'POST /communities/:name/subscribe',
    (s) => s.communities.subscribe('gone', 'u'),
    BY_NAME,
  ],
  [
    'DELETE /communities/:name/subscribe',
    (s) => s.communities.unsubscribe('gone', 'u'),
    BY_NAME,
  ],
  [
    'GET /communities/:name/subscription',
    (s) => s.communities.getSubscription('gone', 'u'),
    BY_NAME,
  ],
  [
    'POST /communities/:name/moderators',
    (s) => s.communities.addModerator('gone', 'm', 'u'),
    BY_NAME,
  ],
  [
    'DELETE /communities/:name/moderators',
    (s) => s.communities.removeModerator('gone', 'm', 'u'),
    BY_NAME,
  ],
  [
    'GET /communities/:name/notification-preferences',
    (s) => s.preferences.get('gone', 'u'),
    BY_NAME,
  ],
  [
    'PUT /communities/:name/notification-preferences',
    (s) => s.preferences.update('gone', 'u', { new_posts: false }),
    BY_NAME,
  ],
  ['GET /communities/:name/rules', (s) => s.rules.getCurrent('gone'), BY_NAME],
  [
    'PUT /communities/:name/rules',
    (s) => s.rules.publish('gone', { items: [{ title: 'Be kind' }] }, 'u'),
    BY_NAME,
  ],
  [
    'GET /communities/:name/rules/versions',
    (s) => s.rules.listVersions('gone', { page: 1, limit: 20 }),
    BY_NAME,
  ],
  [
    'GET /communities/:name/rules/versions/:version',
    (s) => s.rules.getVersion('gone', 1),
    BY_NAME,
  ],
  [
    'GET /communities/:name/rules/acceptance',
    (s) => s.rules.getAcceptance('gone', 'u'),
    BY_NAME,
  ],
  [
    'POST /communities/:name/rules/acceptance',
    (s) => s.rules.accept('gone', 'u', 1),
    BY_NAME,
  ],
  [
    'GET /communities/:name/moderators',
    (s) => s.communities.listModerators('gone', { page: 1, limit: 20 }),
    BY_NAME,
  ],
  [
    'GET /communities/:name/members',
    (s) =>
      s.communities.listMembers('gone', 'u', {
        page: 1,
        limit: 20,
        sort: 'new',
      }),
    BY_NAME,
  ],
  [
    'GET /communities/:name/moderation-log',
    (s) =>
      s.moderationLog.findAll(
        'gone',
        'u',
        new ListCommunityModerationActionsDto(),
      ),
    BY_NAME,
  ],
  [
    'POST /posts',
    (s) =>
      s.posts.create(
        { title: 't', content: 'c', type: 'text', community_id: 'gone' },
        'u',
      ),
    BY_ID,
  ],
  ['GET /posts/:id', (s) => s.posts.findOne('p'), CONTENT],
  ['DELETE /posts/:id', (s) => s.posts.remove('p', 'u'), CONTENT],
  ['GET /posts/:postId/comments', (s) => s.comments.findThread('p'), CONTENT],
  [
    'POST /posts/:postId/comments',
    (s) => s.comments.create('p', { content: 'c' }, 'u'),
    CONTENT,
  ],
  ['DELETE /comments/:id', (s) => s.comments.remove('c', 'u'), CONTENT],
  [
    'POST /votes on a post',
    (s) => s.votes.vote({ target_type: 'post', target_id: 'p', value: 1 }, 'u'),
    CONTENT,
  ],
  [
    'POST /votes on a comment',
    (s) =>
      s.votes.vote({ target_type: 'comment', target_id: 'c', value: 1 }, 'u'),
    CONTENT,
  ],
];

describe('deleted communities are excluded from every read', () => {
  it.each(lookups)(
    '%s answers 404 from an excluding lookup',
    async (_route, call, exclusion) => {
      const { pool, statements } = emptyDatabase();

      await expect(call(services(pool))).rejects.toBeInstanceOf(
        NotFoundException,
      );

      const last = statements[statements.length - 1];
      if (typeof exclusion === 'string') {
        expect(last).toContain(exclusion);
      } else {
        expect(last).toMatch(exclusion);
      }
    },
  );

  it.each([
    ['GET /communities', (s: Services) => s.communities.findAll({})],
    [
      'GET /communities?search=',
      (s: Services) => s.communities.findAll({ search: 'garden' }),
    ],
    [
      'GET /subscriptions',
      (s: Services) => s.communities.listSubscriptions('u', {}),
    ],
  ])('%s lists and counts only live communities', async (_route, call) => {
    const { pool, statements } = emptyDatabase();
    // The count query reads row 0; give it one.
    pool.execute = ((sql: string) => {
      statements.push(sql);
      return Promise.resolve([
        sql.includes('COUNT(*)') ? [{ total: 0 }] : [],
        [],
      ]);
    }) as unknown as Pool['execute'];

    await call(services(pool));

    expect(statements).toHaveLength(2);
    for (const sql of statements) {
      expect(sql).toMatch(/(?:c\.)?deleted_at IS NULL/);
    }
  });

  it.each([
    ['GET /posts', {}],
    ['GET /posts?community_id=', { community_id: 'gone' }],
  ])(
    '%s lists and counts only posts in live communities',
    async (_route, query) => {
      const { pool, statements } = emptyDatabase();
      pool.execute = ((sql: string) => {
        statements.push(sql);
        return Promise.resolve([
          sql.includes('COUNT(*)') ? [{ total: 0 }] : [],
          [],
        ]);
      }) as unknown as Pool['execute'];

      await services(pool).posts.findAll(query);

      expect(statements).toHaveLength(2);
      for (const sql of statements) {
        expect(sql).toContain(CONTENT);
      }
    },
  );

  it('lets a creator whose communities are all deleted delete their account', () => {
    expect(CREATED_COMMUNITY_SQL).toContain('AND deleted_at IS NULL');
  });
});
