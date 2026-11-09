import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { CommentsService } from '../comments/comments.service';
import { CommunitiesService } from '../communities/communities.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { CommunityRulesService } from '../communities/community-rules.service';
import { CommunityStatsService } from '../communities/community-stats.service';
import { ListCommunityModerationActionsDto } from '../communities/dto/list-community-moderation-actions.dto';
import { NotificationPreferencesService } from '../communities/notification-preferences.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { CREATED_COMMUNITY_SQL } from '../users/account-deletion.service';
import { VotesService } from '../votes/votes.service';
import { CommunityBansService } from '../communities/community-bans.service';
import { SavedPostsService } from '../posts/saved-posts.service';
import {
  COMMUNITY_VISIBLE_PREDICATE,
  visibleCommunityColumnsSql,
  visibleCommunitySql,
} from './community-visibility';

// Soft deletion and suspension are only as real as the reads that honour
// them. Every call site that resolves a community, or content that belongs to
// one, is listed here once. Each runs against a database that answers every
// statement with no rows: a lookup must answer 404, and the statement that
// produced the 404 must carry the whole visibility predicate, both hidden
// states. Listings cannot 404, so their SQL is checked directly.

// Both hidden states, bare or aliased: "deleted_at IS NULL AND suspended_at
// IS NULL" or "c.deleted_at IS NULL AND c.suspended_at IS NULL".
const HIDDEN = /(?:c\.)?deleted_at IS NULL AND (?:c\.)?suspended_at IS NULL/;
const BY_NAME = new RegExp(
  /WHERE (?:c\.)?name = \? AND /.source + HIDDEN.source,
);
const BY_ID = new RegExp(
  /FROM communities WHERE id = \? AND /.source + HIDDEN.source,
);
const CONTENT = visibleCommunitySql('posts.community_id');

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
    posts: new PostsService(pool, notifications, ruleAcceptance, moderationLog),
    comments: new CommentsService(pool, notifications, ruleAcceptance),
    votes: new VotesService(pool, ruleAcceptance),
    stats: new CommunityStatsService(pool),
    bans: new CommunityBansService(pool, moderationLog),
    saved: new SavedPostsService(pool),
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
  ['GET /communities/:name/stats', (s) => s.stats.get('gone'), BY_NAME],
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
    'PUT /posts/:id/vote',
    (s) => s.votes.vote({ target_type: 'post', target_id: 'p', value: 1 }, 'u'),
    CONTENT,
  ],
  [
    'PUT /comments/:id/vote',
    (s) =>
      s.votes.vote({ target_type: 'comment', target_id: 'c', value: 1 }, 'u'),
    CONTENT,
  ],
  [
    'GET /communities/:name/bans',
    (s) => s.bans.list('gone', 'u', { page: 1, limit: 20, active: true }),
    BY_NAME,
  ],
  [
    'POST /communities/:name/bans',
    (s) => s.bans.ban('gone', { username: 'someone', reason: 'x' }, 'u'),
    BY_NAME,
  ],
  [
    'PATCH /posts/:id',
    (s) => s.posts.update('p', { title: 't' }, 'u'),
    CONTENT,
  ],
  ['POST /posts/:id/pin', (s) => s.posts.pin('p', 'u'), CONTENT],
  ['POST /posts/:id/lock', (s) => s.posts.lock('p', 'u'), CONTENT],
  ['POST /posts/:id/restore', (s) => s.posts.restore('p', 'u'), CONTENT],
  [
    'POST /posts/:id/remove',
    (s) => s.posts.removeContent('p', { reason: 'spam' }, 'u'),
    CONTENT,
  ],
  [
    'PATCH /comments/:id',
    (s) => s.comments.update('c', { content: 'x' }, 'u'),
    CONTENT,
  ],
  [
    'GET /comments/:id/replies',
    (s) => s.comments.findReplies('c', { page: 1, limit: 20 }),
    CONTENT,
  ],
  ['PUT /posts/:id/save', (s) => s.saved.save('p', 'u'), CONTENT],
];

describe('deleted and suspended communities are excluded from every read and write', () => {
  // The role matrix. A suspended community takes its moderators' and its
  // creator's powers with it, and gives a platform administrator none on the
  // public routes: /admin is where administrators see it. That holds for
  // every caller because the visibility lookup is the call's only statement
  // here, before anything reads who the caller is. Nothing role-dependent can
  // run first and answer 403, which would confirm that the community exists.
  const roles = ['public', 'member', 'moderator', 'creator', 'admin'];
  it.each(
    lookups.flatMap(([route, call]) =>
      roles.map((role) => [route, role, call] as const),
    ),
  )(
    '%s answers a %s caller 404 before any role is consulted',
    async (_route, _role, call) => {
      const { pool, statements } = emptyDatabase();

      await expect(call(services(pool))).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(statements).toHaveLength(1);
    },
  );

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
      expect(sql).toMatch(HIDDEN);
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

// The predicate is the mechanism: two independently applied conditions across
// dozens of call sites would diverge. So no public read or write may restate
// either half. Only /admin, which must see hidden communities, and the
// definition itself name suspended_at or a community's deleted_at directly.
// Files that name the columns for another purpose than visibility.
const NOT_VISIBILITY_CHECKS = [
  // The definition itself.
  'common/community-visibility.ts',
  // The schema's trigger rules over the columns.
  'database/check-trigger-rules.ts',
  // Ownership, not visibility: a suspended community still exists, so its
  // creator still owns it.
  'users/account-deletion.service.ts',
];

describe('the shared community visibility predicate', () => {
  const root = resolve(__dirname, '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory()
        ? sources(full)
        : full.endsWith('.ts') && !full.endsWith('.spec.ts')
          ? [full]
          : [];
    });
  const relativeOf = (file: string) => relative(root, file).replace(/\\/g, '/');

  it('covers both hidden states', () => {
    expect(COMMUNITY_VISIBLE_PREDICATE).toBe(
      'deleted_at IS NULL AND suspended_at IS NULL',
    );
    expect(visibleCommunityColumnsSql('c')).toBe(
      'c.deleted_at IS NULL AND c.suspended_at IS NULL',
    );
    expect(visibleCommunitySql('posts.community_id')).toContain(
      visibleCommunityColumnsSql('communities'),
    );
  });

  it('is restated nowhere outside /admin and its definition', () => {
    const restating = sources(root)
      .filter((file) => {
        const path = relativeOf(file);
        return (
          !path.startsWith('admin/') && !NOT_VISIBILITY_CHECKS.includes(path)
        );
      })
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return (
          /suspended_at IS (NOT )?NULL/.test(text) ||
          /FROM communities\b[^`']*?\bdeleted_at IS NULL/.test(text) ||
          /\b(c|co|communities|target_community)\.deleted_at IS NULL/.test(text)
        );
      })
      .map(relativeOf);
    expect(restating).toEqual([]);
  });
});
