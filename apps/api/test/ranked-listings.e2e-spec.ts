import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import {
  PERMALINK_ANCESTORS_SQL,
  PERMALINK_COMMENT_SQL,
} from '../src/comments/comments.service';
import { hotRank, risingRank } from '../src/common/content-ranking';
import { REMOVED_CONTENT_REVIEWER_SQL } from '../src/common/removed-content';
import { LISTED_COMMUNITY_ID_SQL } from '../src/communities/communities.service';
import {
  FEED_COMMUNITIES_SQL,
  FEED_UNBLOCKED_AUTHOR_SQL,
  POST_COLUMNS,
} from '../src/posts/posts.service';
import { answerSavedFlags } from './fakes/saved-posts';
import { answerVoteScores } from './fakes/vote-scores';

interface FakePost {
  id: string;
  title: string;
  content: string;
  type: 'text';
  author_id: string;
  community_id: string;
  created_at: Date;
  pinned_at: Date | null;
  pinned_by: string | null;
  edited_at: null;
  locked_at: null;
  locked_by: null;
  removed_at: Date | null;
  score: number;
  hot_rank: number;
  rising_rank: number;
}

interface FakeComment {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  content: string;
  created_at: Date;
  edited_at: null;
  locked_at: null;
  locked_by: null;
  removed_at: Date | null;
  removed_by: string | null;
  removal_reason: string | null;
}

const HOUR = 3600 * 1000;

// GET /feed, sort and time on the three post listings, the comment sorts,
// and GET /comments/:id. The stubbed MYSQL_POOL evaluates the listing
// statements over in-memory rows: their filters (subscriptions, bans,
// blocks, hidden communities, removed posts, the time windows against the
// clock) and their ORDER BY over the stored rank columns, so the order a
// route returns is the order its SQL asks for.
describe('Ranked listings, the feed and comment permalinks (e2e)', () => {
  let app: INestApplication<App>;
  let posts: FakePost[];
  let comments: FakeComment[];
  let subscriptions: Set<string>;
  let bans: Set<string>;
  let blocks: Set<string>;
  let hidden: Set<string>;
  let now: number;

  const post = (
    id: string,
    community: string,
    ageHours: number,
    score: number,
    extra: Partial<FakePost> = {},
  ): FakePost => {
    const created_at = new Date(now - ageHours * HOUR);
    return {
      id,
      title: `Title ${id}`,
      content: 'Body',
      type: 'text',
      author_id: 'author',
      community_id: community,
      created_at,
      pinned_at: null,
      pinned_by: null,
      edited_at: null,
      locked_at: null,
      locked_by: null,
      removed_at: null,
      score,
      hot_rank: hotRank(score, created_at),
      rising_rank: risingRank(score, created_at),
      ...extra,
    };
  };
  const comment = (
    id: string,
    parent: string | null,
    extra: Partial<FakeComment> = {},
  ): FakeComment => ({
    id,
    post_id: 'p-fresh',
    parent_id: parent,
    author_id: `author-${id}`,
    content: `Text of ${id}`,
    created_at: new Date('2026-11-10T12:00:00Z'),
    edited_at: null,
    locked_at: null,
    locked_by: null,
    removed_at: null,
    removed_by: null,
    removal_reason: null,
    ...extra,
  });

  beforeEach(async () => {
    now = Date.now();
    posts = [
      // garden: subscribed by user-1.
      post('p-fresh', 'c-garden', 1, 3),
      post('p-popular', 'c-garden', 30, 500),
      post('p-old', 'c-garden', 24 * 40, 1000),
      post('p-pinned', 'c-garden', 48, 0, { pinned_at: new Date(now) }),
      post('p-removed', 'c-garden', 2, 50, { removed_at: new Date(now) }),
      post('p-blocked-author', 'c-garden', 3, 40, { author_id: 'pest' }),
      // kitchen: subscribed, but user-1 is banned there.
      post('p-kitchen', 'c-kitchen', 2, 10),
      // hidden: subscribed, but deleted or suspended.
      post('p-hidden', 'c-hidden', 2, 10),
      // elsewhere: not subscribed.
      post('p-elsewhere', 'c-elsewhere', 1, 900),
    ];
    comments = [
      comment('m-root', null),
      comment('m-child', 'm-root'),
      comment('m-leaf', 'm-child'),
    ];
    subscriptions = new Set([
      'user-1:c-garden',
      'user-1:c-kitchen',
      'user-1:c-hidden',
    ]);
    bans = new Set(['user-1:c-kitchen']);
    blocks = new Set(['user-1:pest']);
    hidden = new Set(['c-hidden']);
    const names: Record<string, string> = {
      garden: 'c-garden',
      kitchen: 'c-kitchen',
      hidden: 'c-hidden',
      elsewhere: 'c-elsewhere',
    };

    const listed = (sql: string, values: unknown[]) => {
      const bound = [...values];
      let rows = posts.filter(
        (row) =>
          !hidden.has(row.community_id) &&
          !(sql.includes('posts.removed_at IS NULL') && row.removed_at),
      );
      if (sql.includes(' WHERE community_id = ?')) {
        const community = bound.shift();
        rows = rows.filter((row) => row.community_id === community);
      }
      if (sql.includes(FEED_COMMUNITIES_SQL)) {
        const user = bound.shift() as string;
        rows = rows.filter(
          (row) =>
            subscriptions.has(`${user}:${row.community_id}`) &&
            !bans.has(`${user}:${row.community_id}`),
        );
      }
      if (sql.includes(FEED_UNBLOCKED_AUTHOR_SQL)) {
        const user = bound.shift() as string;
        rows = rows.filter((row) => !blocks.has(`${user}:${row.author_id}`));
      }
      const window = /CURRENT_TIMESTAMP - INTERVAL (\d+) (HOUR|DAY)/.exec(sql);
      if (window) {
        const span = Number(window[1]) * (window[2] === 'DAY' ? 24 : 1) * HOUR;
        rows = rows.filter((row) => row.created_at.getTime() >= now - span);
      }
      return { rows, bound };
    };
    const ordered = (sql: string, rows: FakePost[]) => {
      const pins = sql.includes('ORDER BY (pinned_at IS NULL)');
      const key =
        /ORDER BY .*?(created_at|hot_rank|score|rising_rank) DESC, id DESC/.exec(
          sql,
        )![1] as 'created_at' | 'hot_rank' | 'score' | 'rising_rank';
      const value = (row: FakePost) =>
        key === 'created_at' ? row.created_at.getTime() : row[key];
      return [...rows].sort(
        (a, b) =>
          (pins ? Number(!a.pinned_at) - Number(!b.pinned_at) : 0) ||
          value(b) - value(a) ||
          b.id.localeCompare(a.id),
      );
    };
    const permalinkRow = (row: FakeComment) => ({
      ...row,
      community_id: 'c-garden',
      post_removed_at: null,
    });

    const execute = (sql: string, values: unknown[] = []) => {
      const scores = answerVoteScores(sql, values);
      if (scores) {
        return Promise.resolve(scores);
      }
      const flags = answerSavedFlags(sql, values);
      if (flags) {
        return Promise.resolve(flags);
      }
      if (sql === LISTED_COMMUNITY_ID_SQL) {
        const id = names[values[0] as string];
        return Promise.resolve([id && !hidden.has(id) ? [{ id }] : [], []]);
      }
      if (sql.startsWith(`SELECT ${POST_COLUMNS} FROM posts WHERE`)) {
        const { rows, bound } = listed(sql, values);
        const [limit, offset] = bound.slice(-2) as [number, number];
        return Promise.resolve([
          ordered(sql, rows).slice(offset, offset + limit),
          [],
        ]);
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM posts WHERE')) {
        return Promise.resolve([
          [{ total: listed(sql, values).rows.length }],
          [],
        ]);
      }
      if (sql === PERMALINK_COMMENT_SQL) {
        return Promise.resolve([
          hidden.has('c-garden')
            ? []
            : comments.filter((row) => row.id === values[0]).map(permalinkRow),
          [],
        ]);
      }
      // The comment routes' post and parent lookups: every post exists.
      if (
        sql.startsWith('SELECT community_id, removed_at FROM posts') ||
        sql.startsWith('SELECT id FROM posts WHERE id = ?') ||
        sql.startsWith('SELECT comments.id FROM comments')
      ) {
        return Promise.resolve([
          [{ id: values[0], community_id: 'c-garden', removed_at: null }],
          [],
        ]);
      }
      // The thread and the two paginated comment listings.
      if (
        sql !== PERMALINK_ANCESTORS_SQL &&
        sql.includes('FROM comments WHERE') &&
        sql.includes('ORDER BY')
      ) {
        return Promise.resolve([comments, []]);
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM comments')) {
        return Promise.resolve([[{ total: comments.length }], []]);
      }
      if (sql === PERMALINK_ANCESTORS_SQL) {
        const chain: FakeComment[] = [];
        let next = comments.find((row) => row.id === values[0]);
        while (next) {
          chain.push(next);
          const parent = next.parent_id;
          next = comments.find((row) => row.id === parent);
        }
        return Promise.resolve([chain.reverse(), []]);
      }
      if (sql === REMOVED_CONTENT_REVIEWER_SQL) {
        return Promise.resolve([[{ can_review: 0 }], []]);
      }
      if (sql.startsWith('SELECT parent_id, COUNT(*) AS reply_count')) {
        const ids = values as string[];
        const counts = new Map<string, number>();
        for (const row of comments) {
          if (row.parent_id && ids.includes(row.parent_id)) {
            counts.set(row.parent_id, (counts.get(row.parent_id) ?? 0) + 1);
          }
        }
        return Promise.resolve([
          [...counts].map(([parent_id, reply_count]) => ({
            parent_id,
            reply_count,
          })),
          [],
        ]);
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    };
    const pool = {
      execute,
      query: execute,
      getConnection: () =>
        Promise.resolve({
          execute,
          query: execute,
          beginTransaction: () => Promise.resolve(),
          commit: () => Promise.resolve(),
          rollback: () => Promise.resolve(),
          release: () => undefined,
        }),
    };
    const users: Record<string, string> = { 'user-token': 'user-1' };

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
            token in users
              ? { kind: 'valid', emailVerified: true, userId: users[token] }
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

  const get = (path: string, token: string | null = 'user-token') => {
    const call = request(app.getHttpServer()).get(path);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };
  const ids = async (path: string, token?: string | null) => {
    const body: unknown = (await get(path, token).expect(200)).body;
    return (body as { items: Array<{ id: string }> }).items.map(
      (item) => item.id,
    );
  };

  describe('GET /feed', () => {
    it('requires a token', async () => {
      await get('/feed', null).expect(401);
      await get('/feed', 'bad-token').expect(401);
    });

    it('lists only the subscribed, visible, unbanned communities, without blocked authors or removed posts', async () => {
      const body: unknown = (await get('/feed').expect(200)).body;
      expect(body).toMatchObject({
        page: 1,
        limit: 20,
        total: 4,
        sort: 'new',
      });
      expect(
        (body as { items: Array<{ id: string }> }).items.map((i) => i.id),
      ).toEqual(['p-fresh', 'p-popular', 'p-pinned', 'p-old']);
    });

    // p-pinned is pinned in garden, where it leads the new and hot views.
    it.each(['new', 'hot'])(
      'does not float pins with sort=%s: they belong to their community listing',
      async (sort) => {
        expect((await ids(`/feed?sort=${sort}`)).indexOf('p-pinned')).toBe(2);
      },
    );

    // hot: log10(score) less age / 12.5 h. p-fresh (0.477 - 0.08 = 0.397)
    // beats p-popular (2.699 - 2.4 = 0.299); p-old, 40 days old, is last.
    it.each([
      ['sort=hot', ['p-fresh', 'p-popular', 'p-pinned', 'p-old']],
      ['sort=top', ['p-old', 'p-popular', 'p-fresh', 'p-pinned']],
      ['sort=top&time=day', ['p-fresh']],
      ['sort=top&time=week', ['p-popular', 'p-fresh', 'p-pinned']],
      ['sort=rising', ['p-fresh']],
    ])('orders ?%s by its stored rank', async (query, expected) => {
      expect(await ids(`/feed?${query}`)).toEqual(expected);
    });

    it('echoes the window of sort=top, defaulting to all', async () => {
      expect((await get('/feed?sort=top').expect(200)).body).toMatchObject({
        sort: 'top',
        time: 'all',
      });
      expect(
        (await get('/feed?sort=top&time=week').expect(200)).body,
      ).toMatchObject({ sort: 'top', time: 'week', total: 3 });
      expect((await get('/feed?sort=hot').expect(200)).body).not.toHaveProperty(
        'time',
      );
    });

    it.each([
      'time=day',
      'sort=new&time=day',
      'sort=rising&time=all',
      'sort=best',
      'sort=top&time=decade',
      'subscribed=true',
      'community_id=c-garden',
      'user_id=someone',
      'page=0',
      'limit=101',
    ])('answers ?%s with 400', async (query) => {
      await get(`/feed?${query}`).expect(400);
    });

    it('pages with a total that matches the listing', async () => {
      const first = (await get('/feed?limit=3').expect(200)).body as {
        items: unknown[];
        total: number;
      };
      const second = (await get('/feed?limit=3&page=2').expect(200)).body as {
        items: unknown[];
      };
      expect(first.items).toHaveLength(3);
      expect(second.items).toHaveLength(first.total - 3);
    });
  });

  describe('sort and time on GET /posts and GET /communities/:name/posts', () => {
    it('ranks the public listing, anonymous or not, and shows every community', async () => {
      expect(await ids('/posts?sort=top&time=day', null)).toEqual([
        'p-elsewhere',
        'p-blocked-author',
        'p-kitchen',
        'p-fresh',
      ]);
      // A shared space: the caller's blocks do not filter it.
      expect(await ids('/posts?sort=top&time=day')).toContain(
        'p-blocked-author',
      );
    });

    it('floats pins on new and hot in a community, never on top or rising', async () => {
      expect((await ids('/communities/garden/posts?sort=hot'))[0]).toBe(
        'p-pinned',
      );
      expect((await ids('/communities/garden/posts'))[0]).toBe('p-pinned');
      expect(await ids('/communities/garden/posts?sort=top')).toEqual([
        'p-old',
        'p-popular',
        'p-blocked-author',
        'p-fresh',
        'p-pinned',
      ]);
      expect(await ids('/posts?community_id=c-garden&sort=rising')).toEqual([
        'p-blocked-author',
        'p-fresh',
      ]);
    });

    it.each(['/posts', '/communities/garden/posts'])(
      'refuses a window without top on %s',
      async (path) => {
        await get(`${path}?time=week`).expect(400);
        await get(`${path}?sort=hot&time=week`).expect(400);
        await get(`${path}?sort=controversial`).expect(400);
      },
    );

    it('still answers 404 for a hidden community, whatever the sort', async () => {
      await get('/communities/hidden/posts?sort=hot').expect(404);
    });
  });

  describe('comment sorts', () => {
    it.each(['oldest', 'new', 'top', 'controversial'])(
      'accepts sort=%s on the thread and both paginated routes',
      async (sort) => {
        for (const path of [
          `/posts/p-fresh/comments?sort=${sort}`,
          `/posts/p-fresh/comments/top-level?sort=${sort}`,
          `/comments/m-root/replies?sort=${sort}`,
        ]) {
          const body: unknown = (await get(path, null).expect(200)).body;
          if ('sort' in (body as object)) {
            expect(body).toMatchObject({ sort });
          }
        }
      },
    );

    it.each(['sort=hot', 'sort=rising', 'time=day', 'page=2'])(
      'refuses ?%s on the thread',
      async (query) => {
        await get(`/posts/p-fresh/comments?${query}`, null).expect(400);
      },
    );
  });

  describe('GET /comments/:id', () => {
    it('returns the comment with its ancestors, root first', async () => {
      const body: unknown = (await get('/comments/m-leaf', null).expect(200))
        .body;
      expect(body).toEqual({
        post_id: 'p-fresh',
        comment: {
          id: 'm-leaf',
          post_id: 'p-fresh',
          parent_id: 'm-child',
          author_id: 'author-m-leaf',
          content: 'Text of m-leaf',
          created_at: '2026-11-10T12:00:00.000Z',
          edited_at: null,
          locked_at: null,
          locked_by: null,
          reply_count: 0,
          score: 0,
        },
        ancestors: [
          expect.objectContaining({ id: 'm-root', reply_count: 1 }),
          expect.objectContaining({ id: 'm-child', reply_count: 1 }),
        ],
      });
    });

    it('returns a top-level comment with no ancestors', async () => {
      const body: unknown = (await get('/comments/m-root').expect(200)).body;
      expect(body).toMatchObject({ comment: { id: 'm-root' }, ancestors: [] });
    });

    it('turns a removed ancestor into a tombstone and a removed comment into 404', async () => {
      comments[0].removed_at = new Date('2026-11-11T00:00:00Z');
      comments[0].removed_by = 'moderator';
      comments[0].removal_reason = 'Spam';
      const body: unknown = (await get('/comments/m-leaf', null).expect(200))
        .body;
      expect((body as { ancestors: unknown[] }).ancestors[0]).toEqual({
        id: 'm-root',
        post_id: 'p-fresh',
        parent_id: null,
        created_at: '2026-11-10T12:00:00.000Z',
        removed: true,
      });
      expect(JSON.stringify(body)).not.toMatch(/Spam|moderator|Text of m-root/);
      await get('/comments/m-root', null).expect(404);
    });

    it('answers an unknown comment with 404 and a malformed id with 400', async () => {
      await get('/comments/no-such-comment', null).expect(404);
      await get('/comments/bad.id', null).expect(400);
    });

    it('is 404 in a hidden community, like the thread', async () => {
      hidden.add('c-garden');
      await get('/comments/m-leaf', null).expect(404);
    });
  });
});
