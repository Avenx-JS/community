import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { SearchQueryDto } from './search-query.dto';

// Under the global pipe, as GET /search really runs.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const run = (query: Record<string, unknown>) =>
  pipe.transform(query, {
    type: 'query',
    metatype: SearchQueryDto,
  }) as Promise<SearchQueryDto>;
const messages = async (query: Record<string, unknown>) => {
  try {
    await run(query);
  } catch (error) {
    const response = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    return response.message;
  }
  throw new Error(`Expected ${JSON.stringify(query)} to be rejected`);
};
const POSTS = { q: 'kitten', type: 'posts' };

describe('SearchQueryDto', () => {
  it('applies defaults and transforms numbers', async () => {
    await expect(run(POSTS)).resolves.toMatchObject({
      q: 'kitten',
      type: 'posts',
      page: 1,
      limit: 20,
      sort: 'relevance',
    });
    await expect(
      run({ ...POSTS, page: '100', limit: '100', sort: 'new' }),
    ).resolves.toMatchObject({ page: 100, limit: 100, sort: 'new' });
  });

  it('trims q', async () => {
    await expect(run({ ...POSTS, q: '  kitten  ' })).resolves.toMatchObject({
      q: 'kitten',
    });
  });

  it.each(['users', 'communities', 'posts', 'comments'])(
    'accepts type=%s',
    async (type) => {
      await expect(run({ q: 'kitten', type })).resolves.toMatchObject({ type });
    },
  );

  describe('q', () => {
    it('is required', async () => {
      await expect(run({ type: 'posts' })).rejects.toThrow();
    });

    // A 200 with an empty list for "go" would look like missing results.
    it('answers a two-character q with 400 naming the minimum', async () => {
      for (const type of ['users', 'communities', 'posts', 'comments']) {
        expect((await messages({ q: 'go', type })).join(' ')).toContain(
          '3 to 100 characters',
        );
      }
      await expect(run({ ...POSTS, q: '  go  ' })).rejects.toThrow();
    });

    it('accepts 3 and 100 characters, and refuses 101', async () => {
      await expect(run({ ...POSTS, q: 'abc' })).resolves.toBeDefined();
      await expect(
        run({ ...POSTS, q: 'a'.repeat(100) }),
      ).resolves.toBeDefined();
      await expect(run({ ...POSTS, q: 'a'.repeat(101) })).rejects.toThrow();
    });

    it('refuses control characters', async () => {
      await expect(run({ ...POSTS, q: 'kit\u0000ten' })).rejects.toThrow();
    });

    // Full-text search drops words under 3 characters, so these could only
    // ever return nothing.
    it.each(['go C', 'a b c d', '+++', '"@*"', '--- (( ))'])(
      'refuses %j for full-text types, which has no 3-character word',
      async (q) => {
        for (const type of ['communities', 'posts', 'comments']) {
          expect((await messages({ q, type })).join(' ')).toContain(
            'a word of at least 3 letters or digits',
          );
        }
      },
    );

    it('allows any 3 characters for a username prefix', async () => {
      await expect(run({ q: 'a_b', type: 'users' })).resolves.toBeDefined();
      await expect(
        run({ q: 'someone@example.com', type: 'users' }),
      ).resolves.toBeDefined();
    });

    it('accepts operator characters, which the service neutralises', async () => {
      await expect(
        run({ ...POSTS, q: '+kitten -puppy "a phrase" @3 (x) ~y z*' }),
      ).resolves.toBeDefined();
    });
  });

  describe('type', () => {
    // A default would silently pick one of four.
    it('is required', async () => {
      await expect(run({ q: 'kitten' })).rejects.toThrow();
    });

    it.each(['all', 'post', 'USERS', ''])('refuses %j', async (type) => {
      await expect(run({ q: 'kitten', type })).rejects.toThrow();
    });
  });

  describe('content filters', () => {
    const filters = [
      { community: 'a-community' },
      { author: 'some_author' },
      { from: '2026-01-01T00:00:00Z' },
      { to: '2026-02-01T00:00:00Z' },
    ];

    it.each(filters)('accepts %o with posts and comments', async (filter) => {
      for (const type of ['posts', 'comments']) {
        await expect(
          run({ q: 'kitten', type, ...filter }),
        ).resolves.toMatchObject(filter);
      }
    });

    it.each(filters)(
      'refuses %o with users and communities',
      async (filter) => {
        for (const type of ['users', 'communities']) {
          const [key] = Object.keys(filter);
          expect(
            (await messages({ q: 'kitten', type, ...filter })).join(' '),
          ).toContain(`${key} applies only to type=posts and type=comments`);
        }
      },
    );

    it.each([
      { community: 'has space' },
      { community: 'x'.repeat(51) },
      { author: 'ab' },
      { author: 'has-hyphen' },
      { from: 'yesterday' },
      { to: '2026-13-40' },
    ])('refuses the malformed %o', async (filter) => {
      await expect(run({ ...POSTS, ...filter })).rejects.toThrow();
    });

    it('refuses a reversed or empty range, accepts an ordered one', async () => {
      const range = (from: string, to: string) => run({ ...POSTS, from, to });
      await expect(
        range('2026-02-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ).rejects.toThrow();
      await expect(
        range('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ).rejects.toThrow();
      await expect(
        range('2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z'),
      ).resolves.toBeDefined();
      expect(
        (
          await messages({
            ...POSTS,
            from: '2026-02-01T00:00:00Z',
            to: '2026-01-01T00:00:00Z',
          })
        ).join(' '),
      ).toContain('to must be later than from');
    });
  });

  describe('paging and sort', () => {
    // OFFSET over a full-text match is the costly part: this route stops at 100.
    it.each([
      { page: '0' },
      { page: '101' },
      { page: '1.5' },
      { limit: '0' },
      { limit: '101' },
      { sort: 'oldest' },
      { sort: 'score' },
    ])('refuses %o', async (query) => {
      await expect(run({ ...POSTS, ...query })).rejects.toThrow();
    });
  });

  it.each([
    { search: 'kitten' },
    { community_id: 'c-1' },
    { author_id: 'u-1' },
    { email: 'a@example.com' },
    { unexpected: '1' },
  ])('refuses the unknown property %o', async (extra) => {
    await expect(run({ ...POSTS, ...extra })).rejects.toThrow();
  });
});
