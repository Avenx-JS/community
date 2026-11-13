import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { ApiRateLimitInterceptor } from '../src/common/api-rate-limit.interceptor';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  bio: string | null;
  created_at: string;
  deleted_at: string | null;
}
interface CommunityRow {
  id: string;
  creator_id: string;
  name: string;
  description: string | null;
  created_at: string;
  deleted_at: string | null;
  suspended_at: string | null;
}
interface PostRow {
  id: string;
  title: string;
  content: string | null;
  type: 'text';
  author_id: string;
  community_id: string;
  created_at: string;
  pinned_at: null;
  pinned_by: null;
  edited_at: null;
  locked_at: null;
  locked_by: null;
  removed_at: string | null;
}
interface CommentRow {
  id: string;
  post_id: string;
  author_id: string;
  content: string;
  created_at: string;
  edited_at: null;
  removed_at: string | null;
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();
const GONE = '2026-03-01T00:00:00.000Z';

// The stubbed pool reads each statement for the rules it states, and applies
// only those: a visibility predicate missing from the SQL leaks a row here,
// exactly as it would against MySQL. MATCH is "any of the bound words, as a
// word", scored by occurrences; LIKE CONCAT(?, '%') is a prefix match.
function makePool() {
  const users: UserRow[] = [
    ['u-alice', 'alice', 'alice.private@example.com'],
    ['u-alina', 'alina', 'alina@example.com'],
    ['u-bob', 'bob_the_builder', 'bob@example.com'],
    ['u-gone', 'deleted_u-gone', 'deleted_u-gone@invalid'],
  ].map(([id, username, email], index) => ({
    id,
    username,
    email,
    password_hash: '$argon2id$secret-hash',
    display_name: index === 0 ? 'Alice A.' : null,
    bio: null,
    created_at: day(index + 1),
    deleted_at: id === 'u-gone' ? GONE : null,
  }));
  const communities: CommunityRow[] = [
    // Whole words only: FULLTEXT has no stemming, so kittens is not kitten.
    ['c-pets', 'pets', 'All about kitten and puppy care', null, null],
    ['c-cooking', 'cooking', 'Recipes and kitchens', null, null],
    ['c-gone', 'kitten-graveyard', 'A deleted kitten community', GONE, null],
    ['c-susp', 'kitten-club', 'A suspended kitten community', null, GONE],
  ].map(([id, name, description, deleted_at, suspended_at], index) => ({
    id: id!,
    creator_id: 'u-alice',
    name: name!,
    description,
    created_at: day(index + 1),
    deleted_at,
    suspended_at,
    // The settings of migration 038, as a fresh community has them.
    visibility: 'public',
    nsfw: 0,
    allowed_post_types: 'text,link,media',
  }));
  const post = (
    id: string,
    community_id: string,
    title: string,
    content: string,
    author_id: string,
    created: number,
    removed = false,
  ): PostRow => ({
    id,
    title,
    content,
    type: 'text',
    author_id,
    community_id,
    created_at: day(created),
    pinned_at: null,
    pinned_by: null,
    edited_at: null,
    locked_at: null,
    locked_by: null,
    removed_at: removed ? GONE : null,
  });
  const posts: PostRow[] = [
    post(
      'p-care',
      'c-pets',
      'Kitten care',
      'How to feed a kitten',
      'u-alice',
      3,
    ),
    post(
      'p-many',
      'c-pets',
      'Kitten kitten',
      'kitten and puppy kitten',
      'u-bob',
      5,
    ),
    post(
      'p-cake',
      'c-cooking',
      'Kitten cake',
      'Shaped like a cat',
      'u-bob',
      20,
    ),
    post('p-removed', 'c-pets', 'Removed kitten', 'kitten', 'u-bob', 6, true),
    post('p-gone', 'c-gone', 'Kitten in deleted', 'kitten', 'u-bob', 7),
    post('p-susp', 'c-susp', 'Kitten in suspended', 'kitten', 'u-bob', 8),
    // 23 more, so paging has several pages to walk.
    ...Array.from({ length: 23 }, (_, index) =>
      post(
        `p-bulk-${String(index).padStart(2, '0')}`,
        'c-cooking',
        `Bulk ${index}`,
        'kitten bulk',
        'u-alice',
        10 + (index % 5),
      ),
    ),
  ];
  const comment = (
    id: string,
    post_id: string,
    content: string,
    created: number,
    removed = false,
  ): CommentRow => ({
    id,
    post_id,
    author_id: 'u-bob',
    content,
    created_at: day(created),
    edited_at: null,
    removed_at: removed ? GONE : null,
  });
  const comments: CommentRow[] = [
    comment('m-ok', 'p-care', 'My kitten loves this', 4),
    comment('m-alice', 'p-cake', 'kitten cake recipe please', 21),
    comment('m-removed', 'p-care', 'Removed kitten comment', 4, true),
    comment('m-on-removed', 'p-removed', 'kitten on a removed post', 7),
    comment('m-gone', 'p-gone', 'kitten in a deleted community', 8),
    comment('m-susp', 'p-susp', 'kitten in a suspended community', 9),
  ];
  comments[1].author_id = 'u-alice';
  const buckets = new Map<string, number>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];

  const tokens = (text: string | null) =>
    (text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const score = (terms: string, ...texts: Array<string | null>) => {
    const words = terms.split(' ').filter(Boolean);
    const all = texts.flatMap(tokens);
    return words.reduce(
      (sum, word) => sum + all.filter((token) => token === word).length,
      0,
    );
  };
  const community = (id: string) => communities.find((row) => row.id === id)!;
  const postOf = (id: string) => posts.find((row) => row.id === id)!;

  // Values after the term(s): content filters in the service's order, then
  // LIMIT and OFFSET on the page.
  function contentFilters(sql: string, values: unknown[], start: number) {
    let at = start;
    const pick = (present: boolean) => (present ? values[at++] : undefined);
    return {
      community: pick(/community_id = \?/.test(sql)),
      author: pick(/author_id = \?/.test(sql)),
      from: pick(/created_at >= CONVERT_TZ/.test(sql)),
      to: pick(/created_at < CONVERT_TZ/.test(sql)),
      next: () => at,
    };
  }
  const inRange = (
    createdAt: string,
    filters: { from?: unknown; to?: unknown },
  ) => {
    const at = Date.parse(createdAt);
    const bound = (value: unknown) =>
      Date.parse(String(value).replace(' ', 'T') + 'Z');
    return (
      (filters.from === undefined || at >= bound(filters.from)) &&
      (filters.to === undefined || at < bound(filters.to))
    );
  };
  const ordered = <T extends { id: string; created_at: string }>(
    sql: string,
    rows: Array<T & { relevance?: number }>,
  ) =>
    [...rows].sort((a, b) =>
      sql.includes('ORDER BY relevance DESC')
        ? (b.relevance ?? 0) - (a.relevance ?? 0) || b.id.localeCompare(a.id)
        : b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
    );
  const pageOf = <T>(sql: string, rows: T[], values: unknown[]) => {
    if (!sql.includes('LIMIT ? OFFSET ?')) {
      return [{ total: rows.length }];
    }
    const limit = Number(values[values.length - 2]);
    const offset = Number(values[values.length - 1]);
    return rows.slice(offset, offset + limit);
  };

  function answer(sql: string, values: unknown[]): unknown[] {
    const flat = sql.replace(/\s+/g, ' ');
    const relevance = flat.includes('AS relevance');
    // The page binds the term twice under relevance; the count never does.
    const termsAt = relevance && flat.includes('LIMIT ? OFFSET ?') ? 1 : 0;

    if (flat.startsWith('SELECT id FROM communities WHERE name = ?')) {
      return communities
        .filter(
          (row) =>
            row.name === values[0] &&
            (!flat.includes('deleted_at IS NULL') || row.deleted_at === null) &&
            (!flat.includes('suspended_at IS NULL') ||
              row.suspended_at === null),
        )
        .map(({ id }) => ({ id }));
    }
    if (flat.startsWith('SELECT id FROM users WHERE username = ?')) {
      return users
        .filter(
          (row) =>
            row.username === values[0] &&
            (!flat.includes('deleted_at IS NULL') || row.deleted_at === null),
        )
        .map(({ id }) => ({ id }));
    }
    if (flat.includes('FROM votes')) {
      return [];
    }
    if (
      /FROM users WHERE username LIKE CONCAT\(\?, '%'\) ESCAPE '='/.test(flat)
    ) {
      const prefix = String(values[0]).replace(/=(.)/g, '$1').toLowerCase();
      let rows = users.filter(
        (row) =>
          row.username.toLowerCase().startsWith(prefix) &&
          (!flat.includes('deleted_at IS NULL') || row.deleted_at === null),
      );
      rows = flat.includes('ORDER BY created_at DESC')
        ? [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))
        : [...rows].sort((a, b) => a.username.localeCompare(b.username));
      return pageOf(sql, rows, values);
    }
    if (
      flat.includes(
        'FROM communities WHERE MATCH (communities.name, communities.description)',
      )
    ) {
      const terms = String(values[termsAt]);
      const rows = communities
        .map((row) => ({
          ...row,
          relevance: score(terms, row.name, row.description),
        }))
        .filter(
          (row) =>
            row.relevance > 0 &&
            (!flat.includes(
              'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
            ) ||
              row.deleted_at === null) &&
            (!flat.includes('communities.suspended_at IS NULL') ||
              row.suspended_at === null),
        );
      return pageOf(sql, ordered(sql, rows), values);
    }
    if (flat.includes('FROM posts WHERE MATCH (posts.title, posts.content)')) {
      const terms = String(values[termsAt]);
      // After the term: the viewer of the community predicate, then filters.
      const filters = contentFilters(flat, values, termsAt + 2);
      const rows = posts
        .map((row) => ({
          ...row,
          relevance: score(terms, row.title, row.content),
        }))
        .filter((row) => {
          const home = community(row.community_id);
          return (
            row.relevance > 0 &&
            (!flat.includes('posts.removed_at IS NULL') ||
              row.removed_at === null) &&
            (!flat.includes(
              'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
            ) ||
              home.deleted_at === null) &&
            (!flat.includes('communities.suspended_at IS NULL') ||
              home.suspended_at === null) &&
            (filters.community === undefined ||
              row.community_id === filters.community) &&
            (filters.author === undefined ||
              row.author_id === filters.author) &&
            inRange(row.created_at, filters)
          );
        });
      return pageOf(sql, ordered(sql, rows), values);
    }
    if (flat.includes('FROM comments c JOIN posts p ON p.id = c.post_id')) {
      const terms = String(values[termsAt]);
      const filters = contentFilters(flat, values, termsAt + 2);
      const rows = comments
        .map((row) => {
          const parent = postOf(row.post_id);
          const home = community(parent.community_id);
          return {
            ...row,
            parent,
            home,
            post_title: parent.title,
            community_name: home.name,
            relevance: score(terms, row.content),
          };
        })
        .filter(
          (row) =>
            row.relevance > 0 &&
            (!flat.includes('c.removed_at IS NULL') ||
              row.removed_at === null) &&
            (!flat.includes('p.removed_at IS NULL') ||
              row.parent.removed_at === null) &&
            (!flat.includes('communities.deleted_at IS NULL') ||
              row.home.deleted_at === null) &&
            (!flat.includes('communities.suspended_at IS NULL') ||
              row.home.suspended_at === null) &&
            (filters.community === undefined ||
              row.parent.community_id === filters.community) &&
            (filters.author === undefined ||
              row.author_id === filters.author) &&
            inRange(row.created_at, filters),
        )
        .map((row) => {
          const { parent, home, ...rest } = row;
          void parent;
          void home;
          return rest;
        });
      return pageOf(sql, ordered(sql, rows), values);
    }
    if (flat.startsWith('INSERT INTO auth_rate_limits')) {
      const key = String(values[0]);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      return [];
    }
    if (flat.includes('FROM auth_rate_limits')) {
      const window = Number(/INTERVAL (\d+) SECOND/.exec(flat)?.[1]);
      return [
        {
          request_count: buckets.get(String(values[0])) ?? 0,
          retry_after: window,
        },
      ];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  return {
    calls,
    pool: {
      execute: (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        try {
          return Promise.resolve([answer(sql, values), []]);
        } catch (error) {
          return Promise.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
      getConnection: () => Promise.reject(new Error('No transactions here')),
    },
  };
}

describe('Search (e2e)', () => {
  let app: INestApplication<App>;
  let calls: Array<{ sql: string; values: unknown[] }>;
  const previousSearchMax = process.env.API_SEARCH_IP_MAX;

  // The rate-limit configuration is read when the service is built.
  const boot = async (searchMax: string) => {
    process.env.API_SEARCH_IP_MAX = searchMax;
    const fake = makePool();
    calls = fake.calls;
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue(fake.pool)
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: () => Promise.resolve({ kind: 'invalid' }),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
    app.useGlobalInterceptors(
      new ApiRateLimitInterceptor(app.get(AuthRateLimitService)),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  };

  beforeEach(() => boot('1000'));

  afterEach(async () => {
    await app.close();
    if (previousSearchMax === undefined) {
      delete process.env.API_SEARCH_IP_MAX;
    } else {
      process.env.API_SEARCH_IP_MAX = previousSearchMax;
    }
  });

  const get = (query: string) =>
    request(app.getHttpServer()).get(`/search?${query}`);
  interface Body {
    type: string;
    items: Array<Record<string, unknown>>;
    page: number;
    limit: number;
    total: number;
  }
  const found = async (query: string) =>
    (await get(query).expect(200)).body as Body;
  const ids = (body: Body) => body.items.map((item) => item.id);
  const allPages = async (query: string) => {
    const seen: string[] = [];
    let total = -1;
    for (let page = 1; page <= 20; page += 1) {
      const body = await found(`${query}&page=${page}&limit=4`);
      total = body.total;
      if (body.items.length === 0) break;
      seen.push(...(ids(body) as string[]));
    }
    return { seen, total };
  };

  describe('each type', () => {
    it('returns posts without a token, as PostResponse items', async () => {
      const body = await found('q=kitten&type=posts&limit=2');
      expect(body).toMatchObject({ type: 'posts', page: 1, limit: 2 });
      expect(body.total).toBe(26);
      expect(Object.keys(body.items[0]).sort()).toEqual(
        [
          'id',
          'title',
          'content',
          'type',
          'author_id',
          'community_id',
          'created_at',
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
        ].sort(),
      );
    });

    it('returns communities as the community DTO', async () => {
      const body = await found('q=kitten&type=communities');
      expect(body).toMatchObject({ type: 'communities', total: 1 });
      expect(body.items).toEqual([
        {
          id: 'c-pets',
          creator_id: 'u-alice',
          name: 'pets',
          description: 'All about kitten and puppy care',
          created_at: day(1),
          visibility: 'public',
          nsfw: false,
          allowed_post_types: ['text', 'link', 'media'],
        },
      ]);
    });

    it('returns flat comments with context and no replies', async () => {
      const body = await found('q=kitten&type=comments&sort=new');
      expect(body.type).toBe('comments');
      expect(ids(body)).toEqual(['m-alice', 'm-ok']);
      expect(body.items[1]).toEqual({
        id: 'm-ok',
        post_id: 'p-care',
        content: 'My kitten loves this',
        created_at: day(4),
        edited_at: null,
        post_title: 'Kitten care',
        community_name: 'pets',
        score: 0,
      });
      for (const item of body.items) {
        expect(item).not.toHaveProperty('replies');
      }
    });

    it('returns users as public profiles, by username prefix', async () => {
      const body = await found('q=ALI&type=users');
      expect(body).toMatchObject({ type: 'users', total: 2 });
      expect(body.items).toEqual([
        {
          username: 'alice',
          display_name: 'Alice A.',
          bio: null,
          created_at: day(1),
          avatar: null,
        },
        {
          username: 'alina',
          display_name: null,
          bio: null,
          created_at: day(2),
          avatar: null,
        },
      ]);
      // A prefix, not a substring: "ice" is inside "alice" but starts nothing.
      expect((await found('q=ice&type=users')).total).toBe(0);
    });

    it('answers a term matching nothing with an empty 200', async () => {
      for (const type of ['users', 'communities', 'posts', 'comments']) {
        await expect(found(`q=zebra&type=${type}`)).resolves.toEqual({
          type,
          items: [],
          page: 1,
          limit: 20,
          total: 0,
        });
      }
    });
  });

  describe('the 400 matrix', () => {
    it.each([
      ['no q', 'type=posts'],
      ['no type', 'q=kitten'],
      ['a 2-character q', 'q=go&type=posts'],
      ['a 101-character q', `q=${'a'.repeat(101)}&type=posts`],
      ['an unknown type', 'q=kitten&type=everything'],
      ['an unknown property', 'q=kitten&type=posts&search=x'],
      ['no 3-character word', 'q=go%20C&type=posts'],
      ['a community filter on users', 'q=kitten&type=users&community=pets'],
      [
        'an author filter on communities',
        'q=kitten&type=communities&author=alice',
      ],
      ['a range on users', 'q=ali&type=users&from=2026-01-01T00:00:00Z'],
      [
        'a reversed range',
        'q=kitten&type=posts&from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      ],
      ['page 101', 'q=kitten&type=posts&page=101'],
      ['limit 101', 'q=kitten&type=posts&limit=101'],
      ['an unknown sort', 'q=kitten&type=posts&sort=oldest'],
    ])('answers %s with 400, querying nothing', async (_name, query) => {
      await get(query).expect(400);
      expect(calls.some(({ sql }) => /MATCH|LIKE/.test(sql))).toBe(false);
    });

    it('names the minimum length for a short q', async () => {
      const response = await get('q=go&type=posts').expect(400);
      expect(JSON.stringify(response.body)).toContain('3 to 100 characters');
    });
  });

  describe('filters', () => {
    it('narrows posts and comments by community and author', async () => {
      expect(
        ids(await found('q=kitten&type=posts&community=pets&sort=new')),
      ).toEqual(['p-many', 'p-care']);
      expect(
        ids(await found('q=kitten&type=posts&author=bob_the_builder&sort=new')),
      ).toEqual(['p-cake', 'p-many']);
      expect(
        ids(await found('q=kitten&type=comments&community=cooking')),
      ).toEqual(['m-alice']);
      expect(ids(await found('q=kitten&type=comments&author=alice'))).toEqual([
        'm-alice',
      ]);
    });

    it.each([
      'community=nowhere',
      'community=kitten-graveyard',
      'community=kitten-club',
      'author=nobody',
    ])('answers %s with 404', async (filter) => {
      await get(`q=kitten&type=posts&${filter}`).expect(404);
      await get(`q=kitten&type=comments&${filter}`).expect(404);
    });

    // A deleted account's placeholder (deleted_<id>) has a hyphen, which no
    // username may contain, so it cannot even be named.
    it('refuses a deleted account’s placeholder as the author', async () => {
      await get('q=kitten&type=posts&author=deleted_u-gone').expect(400);
    });

    it('filters by creation time, half-open', async () => {
      const body = await found(
        `q=kitten&type=posts&from=${day(3)}&to=${day(5)}`,
      );
      expect(ids(body)).toEqual(['p-care']);
      expect(body.total).toBe(1);
    });
  });

  describe('ordering and paging', () => {
    it('orders by match score, ties by id, under relevance', async () => {
      const body = await found('q=kitten&type=posts&limit=3');
      // p-many says kitten four times; p-care and p-cake twice and once.
      expect(ids(body)).toEqual(['p-many', 'p-care', 'p-cake']);
    });

    it('orders newest first under sort=new', async () => {
      const body = await found('q=kitten&type=posts&sort=new&limit=1');
      expect(ids(body)).toEqual(['p-cake']);
    });

    it.each(['relevance', 'new'])(
      'returns each row exactly once across pages under %s, ending on a full last page',
      async (sort) => {
        const { seen, total } = await allPages(
          `q=kitten&type=posts&sort=${sort}`,
        );
        expect(new Set(seen).size).toBe(seen.length);
        expect(seen).toHaveLength(total);
        const last = await found(
          `q=kitten&type=posts&sort=${sort}&limit=4&page=${Math.ceil(total / 4)}`,
        );
        expect(last.items.length).toBeGreaterThan(0);
      },
    );
  });

  // The rows a reader may not see, by type. None may appear, under any sort.
  describe('exclusions', () => {
    const hidden = [
      'p-removed',
      'p-gone',
      'p-susp',
      'm-removed',
      'm-on-removed',
      'm-gone',
      'm-susp',
      'c-gone',
      'c-susp',
    ];

    it.each(['posts', 'comments', 'communities'])(
      'never returns removed or hidden-community %s',
      async (type) => {
        for (const sort of ['relevance', 'new']) {
          const { seen, total } = await allPages(
            `q=kitten&type=${type}&sort=${sort}`,
          );
          expect(seen.filter((id) => hidden.includes(id))).toEqual([]);
          expect(seen).toHaveLength(total);
        }
      },
    );

    it('never returns a deleted account or its placeholder', async () => {
      expect((await found('q=deleted&type=users')).total).toBe(0);
      expect((await found('q=del&type=users')).total).toBe(0);
    });
  });

  // Each boolean-mode operator is plain text: the query means "kitten", and
  // nothing errors or widens.
  describe.each(['+', '-', '>', '<', '(', ')', '~', '*', '"', '@'])(
    'the operator %s',
    (operator) => {
      it('is treated as plain text by every full-text type', async () => {
        const encoded = encodeURIComponent(operator);
        for (const type of ['posts', 'comments', 'communities']) {
          const plain = await found(`q=kitten&type=${type}`);
          for (const q of [
            `${encoded}kitten`,
            `kitten${encoded}`,
            `${encoded}${encoded}kitten${encoded}${encoded}`,
            `kitten%20${encoded}zebra`,
          ]) {
            const body = await found(`q=${q}&type=${type}`);
            expect([q, body.total]).toEqual([q, plain.total]);
          }
        }
        const bound = calls
          .filter(({ sql }) => sql.includes('MATCH'))
          .flatMap(({ values }) => values.filter((v) => typeof v === 'string'));
        for (const value of bound) {
          expect(value).not.toContain(operator);
        }
      });

      it('alone is a 400, never a syntax error', async () => {
        await get(
          `q=${encodeURIComponent(operator.repeat(5))}&type=posts`,
        ).expect(400);
      });
    },
  );

  it('neutralises a combined adversarial query', async () => {
    const q = encodeURIComponent(
      '+kitten -puppy "unterminated (( @8 ~cat* <x >y \'; DROP TABLE posts; --',
    );
    const body = await found(`q=${q}&type=posts`);
    // Any word matches: kitten, puppy, cat, drop, table, posts.
    expect(body.total).toBe(26);
  });

  // GET /admin/users' email search stays admin-only.
  describe('private data', () => {
    const FORBIDDEN =
      /@example\.com|@invalid|password|argon2|secret-hash|"email"|token|session/i;

    it.each([
      'alice.private@example.com',
      'alice.private%40example.com',
      'u-alice',
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    ])('finds no account and leaks nothing for q=%s', async (q) => {
      expect((await found(`q=${q}&type=users`)).total).toBe(0);
      for (const type of ['users', 'communities', 'posts', 'comments']) {
        const response = await get(`q=${q}&type=${type}`);
        expect([type, response.status]).toEqual([type, 200]);
        expect(response.text).not.toMatch(FORBIDDEN);
      }
    });

    it('returns no account id with a user hit', async () => {
      const response = await get('q=alice&type=users').expect(200);
      expect(response.text).not.toMatch(/u-alice|"id"/);
    });

    it('never selects an email or password column', async () => {
      for (const type of ['users', 'communities', 'posts', 'comments']) {
        await found(`q=kitten&type=${type}`);
      }
      for (const { sql } of calls) {
        expect(sql).not.toMatch(/email|password/);
      }
    });
  });

  describe('rate limiting', () => {
    it('answers 429 with Retry-After once the search bucket is spent', async () => {
      await app.close();
      await boot('3');
      for (let index = 0; index < 3; index += 1) {
        await get('q=kitten&type=posts').expect(200);
      }
      const limited = await get('q=kitten&type=posts').expect(429);
      expect(Number(limited.headers['retry-after'])).toBe(60);
      // Other reads are not in the search bucket.
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('counts every search request, valid or not', async () => {
      await app.close();
      await boot('2');
      await get('q=go&type=posts').expect(400);
      await get('type=posts').expect(400);
      await get('q=kitten&type=posts').expect(429);
    });
  });
});
