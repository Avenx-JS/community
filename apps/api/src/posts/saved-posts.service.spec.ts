import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  ANY_POST_SQL,
  SAVEABLE_POST_SQL,
  SAVED_POSTS_COUNT_SQL,
  SAVED_POSTS_FROM,
  SAVE_POST_SQL,
  SavedPostsService,
  UNSAVE_POST_SQL,
  savedPostsSql,
} from './saved-posts.service';

describe('SavedPostsService', () => {
  let service: SavedPostsService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let results: unknown[];

  beforeEach(async () => {
    queries = [];
    results = [];
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return Promise.resolve([results.shift() ?? [], []]);
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [SavedPostsService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();
    service = module.get(SavedPostsService);
  });

  describe('save', () => {
    it('checks the post is saveable, then upserts with the caller from the token', async () => {
      results = [[{ id: 'post-1' }], { affectedRows: 1 }];
      await service.save('post-1', 'user-1');
      expect(queries).toEqual([
        { sql: SAVEABLE_POST_SQL, values: ['post-1'] },
        { sql: SAVE_POST_SQL, values: ['user-1', 'post-1'] },
      ]);
    });

    // A repeat save keeps one row and its created_at: the listing order key.
    it('is an idempotent upsert that never refreshes created_at', () => {
      expect(SAVE_POST_SQL).toBe(
        'INSERT INTO saved_posts (user_id, post_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE created_at = created_at',
      );
    });

    it('requires a visible post: not removed, community neither deleted nor suspended', () => {
      expect(SAVEABLE_POST_SQL).toContain('posts.removed_at IS NULL');
      expect(SAVEABLE_POST_SQL).toContain('communities.deleted_at IS NULL');
      expect(SAVEABLE_POST_SQL).toContain('communities.suspended_at IS NULL');
    });

    it('answers 404 and writes nothing when the post is not saveable', async () => {
      results = [[]];
      await expect(service.save('gone', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(queries).toHaveLength(1);
    });
  });

  describe('unsave', () => {
    it('needs only the post to exist, then deletes the caller’s row', async () => {
      results = [[{ id: 'post-1' }], { affectedRows: 0 }];
      // affectedRows 0: there was no save, still a success.
      await expect(service.unsave('post-1', 'user-1')).resolves.toBeUndefined();
      expect(queries).toEqual([
        { sql: ANY_POST_SQL, values: ['post-1'] },
        { sql: UNSAVE_POST_SQL, values: ['user-1', 'post-1'] },
      ]);
      expect(ANY_POST_SQL).not.toContain('removed_at');
    });

    it('answers 404 for an unknown post', async () => {
      results = [[]];
      await expect(service.unsave('missing', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(queries).toHaveLength(1);
    });
  });

  describe('list', () => {
    const row = (id: string, savedAt: string) => ({
      id,
      title: `Title ${id}`,
      content: 'Body',
      type: 'text',
      author_id: 'author',
      community_id: 'community-1',
      created_at: new Date('2026-10-01T08:00:00.000Z'),
      pinned_at: null,
      pinned_by: null,
      edited_at: null,
      locked_at: null,
      locked_by: null,
      saved_at: new Date(savedAt),
    });

    it('lists the caller’s saves newest-saved first with the envelope', async () => {
      results = [
        [
          row('p2', '2026-11-02T08:00:00.000Z'),
          row('p1', '2026-11-01T08:00:00.000Z'),
        ],
        [{ total: '2' }],
        [{ target_id: 'p1', score: '3' }],
      ];

      const result = await service.list('user-1', {});

      expect(result).toEqual({
        items: [
          {
            post: expect.objectContaining({
              id: 'p2',
              saved: true,
              score: 0,
            }) as unknown,
            saved_at: '2026-11-02T08:00:00.000Z',
          },
          {
            post: expect.objectContaining({
              id: 'p1',
              saved: true,
              score: 3,
            }) as unknown,
            saved_at: '2026-11-01T08:00:00.000Z',
          },
        ],
        page: 1,
        limit: 20,
        total: 2,
        sort: 'new',
      });
      expect(queries[0]).toEqual({
        sql: savedPostsSql('new'),
        values: ['user-1', 20, 0],
      });
      expect(queries[0].sql).toContain(
        'ORDER BY s.created_at DESC, s.post_id DESC',
      );
      expect(queries[1]).toEqual({
        sql: SAVED_POSTS_COUNT_SQL,
        values: ['user-1'],
      });
      // Scores only: every listed post is saved, so no saved-flag lookup.
      expect(queries).toHaveLength(3);
      expect(
        queries.some(({ sql }) =>
          sql.includes('FROM saved_posts WHERE user_id = ? AND post_id IN'),
        ),
      ).toBe(false);
    });

    it('reverses both keys for sort=oldest', async () => {
      results = [[], [{ total: 0 }]];
      await service.list('user-1', { sort: 'oldest' });
      expect(queries[0].sql).toContain(
        'ORDER BY s.created_at ASC, s.post_id ASC',
      );
    });

    it.each([
      { page: 1, limit: 20, offset: 0 },
      { page: 3, limit: 7, offset: 14 },
      { page: 10000, limit: 100, offset: 999900 },
    ])('pages with LIMIT/OFFSET for %o', async ({ page, limit, offset }) => {
      results = [[], [{ total: 0 }]];
      const result = await service.list('user-1', { page, limit });
      expect(queries[0].values).toEqual(['user-1', limit, offset]);
      expect(result).toMatchObject({ page, limit });
    });

    it('answers an account without saves with an empty page', async () => {
      results = [[], [{ total: 0 }]];
      await expect(service.list('user-1', {})).resolves.toEqual({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
        sort: 'new',
      });
    });

    // The easiest thing to get wrong: a total counted without the filters
    // would leave the last page empty.
    it('applies the very same filters to the page and to its total', () => {
      expect(savedPostsSql('new')).toContain(SAVED_POSTS_FROM);
      expect(savedPostsSql('oldest')).toContain(SAVED_POSTS_FROM);
      expect(SAVED_POSTS_COUNT_SQL).toBe(
        `SELECT COUNT(*) AS total ${SAVED_POSTS_FROM}`,
      );
      expect(SAVED_POSTS_FROM).toContain('WHERE s.user_id = ?');
      expect(SAVED_POSTS_FROM).toContain('p.removed_at IS NULL');
      expect(SAVED_POSTS_FROM).toContain('communities.deleted_at IS NULL');
      expect(SAVED_POSTS_FROM).toContain('communities.suspended_at IS NULL');
      // A deleted author is no reason to drop a save.
      expect(SAVED_POSTS_FROM).not.toContain('users');
    });
  });
});
