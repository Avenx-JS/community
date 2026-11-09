import { beforeEach, describe, expect, it } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { visibleCommunitySql } from '../common/community-visibility';
import {
  USER_COMMENTS_COUNT_SQL,
  USER_COMMUNITIES_COUNT_SQL,
  USER_COMMUNITIES_SQL,
  USER_ID_BY_USERNAME_SQL,
  USER_POSTS_COUNT_SQL,
  UserActivityService,
  userCommentsSql,
  userPostsSql,
} from './user-activity.service';

describe('UserActivityService', () => {
  let queries: Array<{ sql: string; values: unknown[] }>;
  let results: Map<string, unknown[]>;
  let service: UserActivityService;

  beforeEach(() => {
    queries = [];
    // The username resolves to user-7 unless a test says otherwise.
    results = new Map<string, unknown[]>([
      [USER_ID_BY_USERNAME_SQL, [{ id: 'user-7' }]],
    ]);
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT COUNT(*)')) {
          return Promise.resolve([results.get(sql) ?? [{ total: 0 }], []]);
        }
        return Promise.resolve([results.get(sql) ?? [], []]);
      },
    };
    service = new UserActivityService(pool as unknown as Pool);
  });

  const listings = () => queries.slice(1);

  describe('username resolution', () => {
    it('binds the username and excludes deleted accounts', async () => {
      await service.listPosts('some_user', {});
      expect(queries[0]).toEqual({
        sql: 'SELECT id FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1',
        values: ['some_user'],
      });
    });

    it.each(['listPosts', 'listComments', 'listCommunities'] as const)(
      '%s answers 404 for an unknown or deleted user before any other query',
      async (method) => {
        results.set(USER_ID_BY_USERNAME_SQL, []);
        await expect(service[method]('nobody', {})).rejects.toThrow(
          new NotFoundException('User not found'),
        );
        expect(queries).toHaveLength(1);
      },
    );
  });

  describe('posts', () => {
    it('excludes removed posts and posts in deleted or suspended communities', () => {
      for (const sql of [userPostsSql('new'), USER_POSTS_COUNT_SQL]) {
        expect(sql).toContain('WHERE author_id = ? AND removed_at IS NULL');
        expect(sql).toContain('communities.id = posts.community_id');
        expect(sql).toContain(
          'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
        );
        expect(sql).toContain('communities.suspended_at IS NULL');
      }
      // The one shared visibility predicate, as every other post read uses.
      expect(userPostsSql('new')).toContain(
        visibleCommunitySql('posts.community_id'),
      );
    });

    it.each([
      ['new', 'ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'],
      ['oldest', 'ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?'],
    ] as const)('orders %s with the id tiebreaker', (sort, clause) => {
      expect(userPostsSql(sort)).toMatch(new RegExp(`${escape(clause)}$`));
    });

    it('binds the user id with LIMIT and OFFSET from page and limit', async () => {
      results.set(USER_POSTS_COUNT_SQL, [{ total: '42' }]);
      const result = await service.listPosts('some_user', {
        page: 3,
        limit: 10,
        sort: 'oldest',
      });

      expect(listings()).toEqual([
        { sql: userPostsSql('oldest'), values: ['user-7', 10, 20] },
        { sql: USER_POSTS_COUNT_SQL, values: ['user-7'] },
      ]);
      expect(result).toEqual({ items: [], page: 3, limit: 10, total: 42 });
    });

    it('defaults to page 1, limit 20, newest first', async () => {
      await service.listPosts('some_user', {});
      expect(listings()[0]).toEqual({
        sql: userPostsSql('new'),
        values: ['user-7', 20, 0],
      });
    });

    it('renders rows as the shared post DTO', async () => {
      results.set(userPostsSql('new'), [
        {
          id: 'p1',
          title: 'Hello',
          content: 'World',
          type: 'text',
          author_id: 'user-7',
          community_id: 'c1',
          created_at: new Date('2026-10-22T08:00:00.000Z'),
          pinned_at: null,
          pinned_by: null,
          // Never selected; ignored if a driver returned it anyway.
          email: 'leak@example.com',
        },
      ]);
      const { items } = await service.listPosts('some_user', {});
      expect(items).toEqual([
        {
          id: 'p1',
          title: 'Hello',
          content: 'World',
          type: 'text',
          author_id: 'user-7',
          community_id: 'c1',
          created_at: '2026-10-22T08:00:00.000Z',
          pinned_at: null,
          pinned_by: null,
          edited_at: null,
          locked_at: null,
          locked_by: null,
          score: 0,
          saved: false,
        },
      ]);
    });
  });

  describe('comments', () => {
    it('excludes removed comments, comments on removed posts, and deleted or suspended communities', () => {
      for (const sql of [userCommentsSql('new'), USER_COMMENTS_COUNT_SQL]) {
        expect(sql).toContain('WHERE c.author_id = ?');
        expect(sql).toContain('AND c.removed_at IS NULL');
        expect(sql).toContain('AND p.removed_at IS NULL');
        expect(sql).toContain('AND co.deleted_at IS NULL');
        expect(sql).toContain('AND co.suspended_at IS NULL');
      }
    });

    it('joins the post and the community for the link context, comments first', () => {
      expect(userCommentsSql('new')).toMatch(
        /FROM comments c\s+STRAIGHT_JOIN posts p ON p\.id = c\.post_id\s+STRAIGHT_JOIN communities co ON co\.id = p\.community_id/,
      );
      expect(userCommentsSql('new')).toContain('p.title AS post_title');
      expect(userCommentsSql('new')).toContain('co.name AS community_name');
    });

    it.each([
      ['new', 'ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?'],
      ['oldest', 'ORDER BY c.created_at ASC, c.id ASC LIMIT ? OFFSET ?'],
    ] as const)('orders %s with the id tiebreaker', (sort, clause) => {
      expect(userCommentsSql(sort)).toMatch(new RegExp(`${escape(clause)}$`));
    });

    it('returns flat items with ISO timestamps and no replies', async () => {
      results.set(userCommentsSql('new'), [
        {
          id: 'm1',
          post_id: 'p1',
          content: 'Nice',
          created_at: new Date('2026-10-22T08:00:00.000Z'),
          edited_at: new Date('2026-10-23T08:00:00.000Z'),
          post_title: 'Hello',
          community_name: 'general',
          author_id: 'user-7',
        },
        {
          id: 'm2',
          post_id: 'p1',
          content: 'Plain',
          created_at: new Date('2026-10-21T08:00:00.000Z'),
          edited_at: null,
          post_title: 'Hello',
          community_name: 'general',
        },
      ]);
      results.set(USER_COMMENTS_COUNT_SQL, [{ total: 2 }]);

      const result = await service.listComments('some_user', {
        page: 2,
        limit: 5,
      });

      expect(listings()[0].values).toEqual(['user-7', 5, 5]);
      expect(result).toEqual({
        items: [
          {
            id: 'm1',
            post_id: 'p1',
            content: 'Nice',
            created_at: '2026-10-22T08:00:00.000Z',
            edited_at: '2026-10-23T08:00:00.000Z',
            post_title: 'Hello',
            community_name: 'general',
            score: 0,
          },
          {
            id: 'm2',
            post_id: 'p1',
            content: 'Plain',
            created_at: '2026-10-21T08:00:00.000Z',
            edited_at: null,
            post_title: 'Hello',
            community_name: 'general',
            score: 0,
          },
        ],
        page: 2,
        limit: 5,
        total: 2,
      });
    });
  });

  describe('communities', () => {
    it.each([
      [
        'creator',
        'SELECT id AS community_id FROM communities WHERE creator_id = ?',
      ],
      [
        'moderator',
        'SELECT community_id FROM community_moderators WHERE user_id = ?',
      ],
      [
        'contributor by post',
        'SELECT community_id FROM posts\n         WHERE author_id = ? AND removed_at IS NULL',
      ],
      [
        'contributor by comment',
        'WHERE c.author_id = ? AND c.removed_at IS NULL AND p.removed_at IS NULL',
      ],
    ])('includes the %s branch', (_branch, fragment) => {
      expect(USER_COMMUNITIES_SQL).toContain(fragment);
      expect(USER_COMMUNITIES_COUNT_SQL).toContain(fragment);
    });

    it('never lists a subscription and returns no timestamp', () => {
      for (const sql of [USER_COMMUNITIES_SQL, USER_COMMUNITIES_COUNT_SQL]) {
        expect(sql).not.toContain('community_subscriptions');
      }
      const selected = /^SELECT ([\s\S]*?)\s+FROM \(/.exec(
        USER_COMMUNITIES_SQL,
      )?.[1];
      expect(selected).toBeDefined();
      expect(selected).not.toMatch(/_at\b|created|subscribed/);
    });

    it('excludes deleted and suspended communities and orders by name', () => {
      expect(USER_COMMUNITIES_SQL).toContain(
        'WHERE co.deleted_at IS NULL AND co.suspended_at IS NULL',
      );
      expect(USER_COMMUNITIES_COUNT_SQL).toContain(
        'WHERE co.deleted_at IS NULL AND co.suspended_at IS NULL',
      );
      expect(USER_COMMUNITIES_SQL).toMatch(
        /ORDER BY co\.name ASC LIMIT \? OFFSET \?$/,
      );
    });

    it('ranks the roles creator, then moderator, then contributor', () => {
      const role = /CASE([\s\S]*?)END AS role/.exec(USER_COMMUNITIES_SQL)?.[1];
      expect(role).toMatch(
        /WHEN co\.creator_id = \? THEN 'creator'[\s\S]*THEN 'moderator'[\s\S]*ELSE 'contributor'/,
      );
    });

    it('binds the user id for the role and every branch, then LIMIT and OFFSET', async () => {
      results.set(USER_COMMUNITIES_SQL, [
        { name: 'general', description: null, role: 'creator', id: 'c1' },
      ]);
      results.set(USER_COMMUNITIES_COUNT_SQL, [{ total: 1 }]);

      const result = await service.listCommunities('some_user', {
        page: 2,
        limit: 3,
      });

      expect(listings()).toEqual([
        {
          sql: USER_COMMUNITIES_SQL,
          values: [...new Array<string>(6).fill('user-7'), 3, 3],
        },
        {
          sql: USER_COMMUNITIES_COUNT_SQL,
          values: new Array<string>(4).fill('user-7'),
        },
      ]);
      expect(USER_COMMUNITIES_SQL.split('?')).toHaveLength(9);
      expect(USER_COMMUNITIES_COUNT_SQL.split('?')).toHaveLength(5);
      expect(result).toEqual({
        items: [{ name: 'general', description: null, role: 'creator' }],
        page: 2,
        limit: 3,
        total: 1,
      });
    });
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
