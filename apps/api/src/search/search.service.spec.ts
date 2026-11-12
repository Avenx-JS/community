import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import { SearchQueryDto } from './dto/search-query.dto';
import { SearchService } from './search.service';

type Call = { sql: string; values: unknown[] };

describe('SearchService', () => {
  let calls: Call[];
  let rows: Array<Record<string, unknown>>;
  let total: number;
  let lookups: Record<string, string | undefined>;
  let service: SearchService;

  beforeEach(() => {
    calls = [];
    rows = [];
    total = 0;
    lookups = { 'a-community': 'community-id', some_author: 'author-id' };
    service = new SearchService({
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT id FROM')) {
          const id = lookups[values[0] as string];
          return Promise.resolve([id ? [{ id }] : [], []]);
        }
        if (sql.startsWith('SELECT COUNT(*) AS total')) {
          return Promise.resolve([[{ total }], []]);
        }
        if (sql.includes('FROM votes')) {
          return Promise.resolve([[], []]);
        }
        return Promise.resolve([rows, []]);
      },
    } as unknown as Pool);
  });

  const search = (query: Partial<SearchQueryDto>) =>
    service.search(Object.assign(new SearchQueryDto(), query));
  const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const page = () =>
    calls.find(
      ({ sql }) => sql.includes('LIMIT ? OFFSET ?') && !sql.includes('votes'),
    )!;
  const count = () =>
    calls.find(({ sql }) => sql.startsWith('SELECT COUNT(*) AS total'))!;
  // FROM ... WHERE ... of a statement: what items and total must share.
  const fromWhere = (sql: string) =>
    flat(sql)
      .replace(/^SELECT .*? (FROM \w+)/, '$1')
      .replace(/ ORDER BY .*$/, '');

  describe.each([
    [
      'posts',
      'MATCH (posts.title, posts.content) AGAINST (? IN BOOLEAN MODE)',
      [
        'posts.removed_at IS NULL',
        'communities.id = posts.community_id',
        'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
        'communities.suspended_at IS NULL',
        "communities.visibility <> 'private'",
        'viewer_preferences.show_nsfw = TRUE',
        'FROM community_mutes viewer_mute',
      ],
    ],
    [
      'comments',
      'MATCH (c.content) AGAINST (? IN BOOLEAN MODE)',
      [
        'c.removed_at IS NULL',
        'p.removed_at IS NULL',
        'communities.id = p.community_id',
        'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
        // Migration 038: private, nsfw and muted communities.
        "communities.visibility <> 'private'",
        'viewer_preferences.show_nsfw = TRUE',
        'FROM community_mutes viewer_mute',
      ],
    ],
    [
      'communities',
      'MATCH (communities.name, communities.description) AGAINST (? IN BOOLEAN MODE)',
      [
        'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
        'communities.suspended_at IS NULL',
      ],
    ],
  ] as const)('type=%s', (type, match, exclusions) => {
    it('matches with the index’s exact column list, in boolean mode', async () => {
      await search({ q: 'kitten', type });
      expect(flat(page().sql)).toContain(`WHERE ${match}`);
      expect(flat(count().sql)).toContain(`WHERE ${match}`);
      expect(page().sql).not.toMatch(/NATURAL LANGUAGE|WITH QUERY EXPANSION/);
    });

    it('applies every exclusion, identically to items and total', async () => {
      await search({ q: 'kitten', type });
      for (const predicate of exclusions) {
        expect(flat(page().sql)).toContain(predicate);
      }
      expect(fromWhere(page().sql)).toBe(fromWhere(count().sql));
    });

    it('binds the sanitised words, never interpolating them', async () => {
      await search({ q: '+Kitten -"puppy" @8 (cat*)', type });
      for (const { sql } of calls) {
        expect(sql).not.toMatch(/kitten|puppy/i);
      }
      // relevance binds the term for the score and for the match.
      expect(page().values.slice(0, 2)).toEqual([
        'kitten puppy cat',
        'kitten puppy cat',
      ]);
      expect(count().values[0]).toBe('kitten puppy cat');
    });

    it('orders by score with an id tiebreaker for relevance', async () => {
      await search({ q: 'kitten', type });
      expect(flat(page().sql)).toContain(`, ${match} AS relevance`);
      expect(flat(page().sql)).toMatch(
        /ORDER BY relevance DESC, \w+\.id DESC LIMIT \? OFFSET \?$/,
      );
    });

    it('orders newest first with an id tiebreaker for new, binding the term once', async () => {
      await search({ q: 'kitten', type, sort: 'new' });
      expect(flat(page().sql)).toMatch(
        /ORDER BY (\w+)\.created_at DESC, \1\.id DESC LIMIT \? OFFSET \?$/,
      );
      expect(page().sql).not.toContain('AS relevance');
      // The term, then the viewer (anonymous here) of the community filter.
      expect(page().values).toEqual(['kitten', null, 20, 0]);
    });

    it('pages by LIMIT and OFFSET', async () => {
      await search({ q: 'kitten', type, page: 4, limit: 25, sort: 'new' });
      expect(page().values.slice(-2)).toEqual([25, 75]);
    });

    it('returns an empty page for no match', async () => {
      await expect(search({ q: 'kitten', type })).resolves.toEqual({
        type,
        items: [],
        page: 1,
        limit: 20,
        total: 0,
      });
    });
  });

  describe('type=users', () => {
    it('prefix-matches the indexed username with no leading wildcard', async () => {
      await search({ q: 'ali', type: 'users' });
      expect(flat(page().sql)).toBe(
        "SELECT username, display_name, bio, created_at, avatar_media_id FROM users WHERE username LIKE CONCAT(?, '%') ESCAPE '=' AND deleted_at IS NULL ORDER BY username ASC LIMIT ? OFFSET ?",
      );
      expect(page().values).toEqual(['ali', 20, 0]);
      expect(fromWhere(page().sql)).toBe(fromWhere(count().sql));
      for (const { sql } of calls) {
        expect(sql).not.toMatch(/LIKE '%|CONCAT\('%'|LOWER\(|MATCH/);
      }
    });

    it('escapes LIKE wildcards, so they match literally', async () => {
      await search({ q: 'a%b_c=', type: 'users' });
      expect(page().values[0]).toBe('a=%b=_c==');
    });

    // GET /admin/users' email search stays admin-only.
    it('never matches or selects the email, id or password', async () => {
      await search({ q: 'someone@example.com', type: 'users' });
      for (const { sql } of calls) {
        expect(sql).not.toMatch(
          /email|password|\bid\b|display_name LIKE|bio LIKE/,
        );
      }
    });

    it('returns the public profile only', async () => {
      rows = [
        {
          username: 'alice',
          display_name: null,
          bio: 'Hi',
          created_at: '2026-01-01T00:00:00Z',
          email: 'leak@example.com',
          id: 'user-id',
        },
      ];
      const { items } = await search({ q: 'ali', type: 'users' });
      expect(items).toEqual([
        {
          username: 'alice',
          display_name: null,
          bio: 'Hi',
          created_at: '2026-01-01T00:00:00.000Z',
          avatar: null,
        },
      ]);
    });

    it('sorts newest first under sort=new, by username under relevance', async () => {
      await search({ q: 'ali', type: 'users', sort: 'new' });
      expect(flat(page().sql)).toContain(
        'ORDER BY created_at DESC, username ASC',
      );
    });
  });

  describe('content filters', () => {
    it.each([
      ['posts', 'posts.community_id', 'posts.author_id', 'posts.created_at'],
      ['comments', 'p.community_id', 'c.author_id', 'c.created_at'],
    ] as const)(
      'applies community, author and range to %s, in items and total',
      async (type, community, author, createdAt) => {
        await search({
          q: 'kitten',
          type,
          sort: 'new',
          community: 'a-community',
          author: 'some_author',
          from: '2026-01-01T00:00:00Z',
          to: '2026-02-01T00:00:00+02:00',
        });
        for (const { sql } of [page(), count()]) {
          expect(flat(sql)).toContain(
            `AND ${community} = ? AND ${author} = ? AND ${createdAt} >= CONVERT_TZ(?, '+00:00', @@session.time_zone) AND ${createdAt} < CONVERT_TZ(?, '+00:00', @@session.time_zone)`,
          );
        }
        expect(count().values).toEqual([
          'kitten',
          null,
          'community-id',
          'author-id',
          '2026-01-01 00:00:00',
          '2026-01-31 22:00:00',
        ]);
        expect(fromWhere(page().sql)).toBe(fromWhere(count().sql));
      },
    );

    it('resolves the community only if it is visible', async () => {
      await search({ q: 'kitten', type: 'posts', community: 'a-community' });
      expect(calls[0].sql).toBe(
        'SELECT id FROM communities WHERE name = ? AND deleted_at IS NULL AND suspended_at IS NULL LIMIT 1',
      );
    });

    it('resolves the author only if the account is not deleted', async () => {
      await search({ q: 'kitten', type: 'posts', author: 'some_author' });
      expect(calls[0].sql).toBe(
        'SELECT id FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1',
      );
    });

    it.each([
      [{ community: 'nowhere' }, 'Community not found'],
      [{ author: 'nobody' }, 'User not found'],
    ])('answers %o with 404 before searching', async (filter, message) => {
      await expect(
        search({ q: 'kitten', type: 'comments', ...filter }),
      ).rejects.toThrow(new NotFoundException(message));
      expect(calls.some(({ sql }) => sql.includes('MATCH'))).toBe(false);
    });
  });

  it('maps a comment hit to a flat item with its context and score', async () => {
    rows = [
      {
        id: 'c-1',
        post_id: 'p-1',
        content: 'A kitten',
        created_at: '2026-01-01T00:00:00Z',
        edited_at: null,
        post_title: 'Pets',
        community_name: 'animals',
        relevance: 1.5,
      },
    ];
    const { items } = await search({ q: 'kitten', type: 'comments' });
    expect(items).toEqual([
      {
        id: 'c-1',
        post_id: 'p-1',
        content: 'A kitten',
        created_at: '2026-01-01T00:00:00.000Z',
        edited_at: null,
        post_title: 'Pets',
        community_name: 'animals',
        score: 0,
      },
    ]);
    expect(items[0]).not.toHaveProperty('replies');
    expect(items[0]).not.toHaveProperty('relevance');
  });
});
