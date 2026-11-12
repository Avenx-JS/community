import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
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
  ANY_POST_SQL,
  SAVEABLE_POST_SQL,
  SAVED_POSTS_COUNT_SQL,
  SAVE_POST_SQL,
  UNSAVE_POST_SQL,
  savedPostsSql,
} from '../src/posts/saved-posts.service';
import { answerSavedFlags, type FakeSave } from './fakes/saved-posts';
import { answerVoteScores } from './fakes/vote-scores';

interface FakePost {
  id: string;
  title: string;
  content: string;
  type: 'text';
  author_id: string;
  community_id: string;
  created_at: Date;
  pinned_at: null;
  pinned_by: null;
  removed_at: Date | null;
  // Planted on every row: no response may ever carry them.
  email: string;
  password_hash: string;
}

interface StoredSave extends FakeSave {
  created_at: Date;
}

// POST and DELETE /posts/:id/save and GET /users/me/saved-posts, with the
// caller-dependent saved flag on GET /posts and GET /posts/:id. A stubbed
// MYSQL_POOL that evaluates the service's statements over in-memory tables,
// including the listing's filters, so total and the pages can be checked
// against each other.
describe('Saved posts (e2e)', () => {
  let app: INestApplication<App>;
  let posts: FakePost[];
  let saves: StoredSave[];
  let deletedCommunities: Set<string>;
  let suspendedCommunities: Set<string>;
  let queryCalls: Array<{ sql: string; values: unknown[] }>;
  let clock: number;
  let ruleChecks: number;

  const post = (id: string, communityId = 'community-1'): FakePost => ({
    id,
    title: `Title ${id}`,
    content: 'Body',
    type: 'text',
    author_id: 'author',
    community_id: communityId,
    created_at: new Date('2026-10-01T08:00:00.000Z'),
    pinned_at: null,
    pinned_by: null,
    removed_at: null,
    email: 'leak@example.test',
    password_hash: 'argon2id$leak',
  });

  beforeEach(async () => {
    posts = [
      post('post-1'),
      post('post-2'),
      post('post-3'),
      post('post-in-deleted', 'community-deleted'),
      post('post-in-suspended', 'community-suspended'),
    ];
    saves = [];
    deletedCommunities = new Set(['community-deleted']);
    suspendedCommunities = new Set(['community-suspended']);
    queryCalls = [];
    clock = Date.parse('2026-11-01T08:00:00.000Z');
    ruleChecks = 0;

    const communityHidden = (communityId: string, sql: string) =>
      (sql.includes('deleted_at IS NULL') &&
        deletedCommunities.has(communityId)) ||
      (sql.includes('suspended_at IS NULL') &&
        suspendedCommunities.has(communityId));
    // The listing's filters, as SAVED_POSTS_FROM states them.
    const listed = (userId: string, sql: string) =>
      saves
        .filter((save) => save.user_id === userId)
        .map((save) => ({
          save,
          post: posts.find((entry) => entry.id === save.post_id)!,
        }))
        .filter(
          ({ post }) =>
            !post.removed_at && !communityHidden(post.community_id, sql),
        );

    const execute = (sql: string, values: unknown[]) => {
      queryCalls.push({ sql, values });
      const scores = answerVoteScores(sql, values);
      if (scores) {
        return Promise.resolve(scores);
      }
      const flags = answerSavedFlags(sql, values, saves);
      if (flags) {
        return Promise.resolve(flags);
      }
      if (sql === SAVEABLE_POST_SQL) {
        const target = posts.find((entry) => entry.id === values[0]);
        return Promise.resolve([
          target &&
          !target.removed_at &&
          !communityHidden(target.community_id, sql)
            ? [{ id: target.id }]
            : [],
          [],
        ]);
      }
      if (sql === ANY_POST_SQL) {
        return Promise.resolve([
          posts
            .filter((entry) => entry.id === values[0])
            .map(({ id }) => ({ id })),
          [],
        ]);
      }
      if (sql === SAVE_POST_SQL) {
        const [userId, postId] = values as string[];
        if (!saves.some((s) => s.user_id === userId && s.post_id === postId)) {
          saves.push({
            user_id: userId,
            post_id: postId,
            created_at: new Date(clock),
          });
        }
        clock += 60_000;
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if (sql === UNSAVE_POST_SQL) {
        const [userId, postId] = values as string[];
        const before = saves.length;
        saves = saves.filter(
          (s) => !(s.user_id === userId && s.post_id === postId),
        );
        return Promise.resolve([{ affectedRows: before - saves.length }, []]);
      }
      if (sql === savedPostsSql('new') || sql === savedPostsSql('oldest')) {
        // Values: the caller, the caller again (read access), limit, offset.
        const [userId, , limit, offset] = values as [
          string,
          string,
          number,
          number,
        ];
        const direction = sql === savedPostsSql('oldest') ? 1 : -1;
        const rows = listed(userId, sql)
          .sort(
            (left, right) =>
              direction *
              (left.save.created_at.getTime() -
                right.save.created_at.getTime() ||
                left.post.id.localeCompare(right.post.id)),
          )
          .slice(offset, offset + limit)
          .map(({ save, post }) => ({ ...post, saved_at: save.created_at }));
        return Promise.resolve([rows, []]);
      }
      if (sql === SAVED_POSTS_COUNT_SQL) {
        const [userId] = values as [string];
        return Promise.resolve([[{ total: listed(userId, sql).length }], []]);
      }
      // GET /posts/:id and GET /posts, for the saved flag.
      if (
        sql.startsWith('SELECT id, title, content, type') &&
        sql.includes('WHERE id = ?')
      ) {
        return Promise.resolve([
          posts.filter(
            (entry) =>
              entry.id === values[0] &&
              !communityHidden(entry.community_id, sql),
          ),
          [],
        ]);
      }
      if (
        sql.startsWith('SELECT id, title, content, type') &&
        sql.includes('ORDER BY')
      ) {
        return Promise.resolve([
          posts.filter(
            (entry) =>
              !entry.removed_at && !communityHidden(entry.community_id, sql),
          ),
          [],
        ]);
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM posts')) {
        return Promise.resolve([[{ total: 3 }], []]);
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };

    const tokens: Record<string, string> = {
      'token-a': 'user-a',
      'token-b': 'user-b',
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({ execute })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            token in tokens
              ? { kind: 'valid', emailVerified: true, userId: tokens[token] }
              : { kind: 'invalid' },
          ),
      })
      .overrideProvider(CommunityRuleAcceptanceService)
      .useValue({
        // Saving is not participation: the gate must never be consulted.
        assertAcceptedOrThrow: () => {
          ruleChecks += 1;
          return Promise.reject(new Error('rule gate consulted'));
        },
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
    expect(ruleChecks).toBe(0);
    await app.close();
  });

  const as = (token?: string) => {
    const server = () => request(app.getHttpServer());
    const auth = (call: request.Test) =>
      token ? call.set('Authorization', `Bearer ${token}`) : call;
    return {
      save: (id: string) => auth(server().post(`/posts/${id}/save`)),
      unsave: (id: string) => auth(server().delete(`/posts/${id}/save`)),
      list: (query = '') => auth(server().get(`/users/me/saved-posts${query}`)),
      get: (path: string) => auth(server().get(path)),
    };
  };
  const userA = as('token-a');
  const userB = as('token-b');
  type Page = {
    items: { post: { id: string; saved: boolean }; saved_at: string }[];
    page: number;
    limit: number;
    total: number;
    sort: string;
  };
  const listIds = async (query = '', token = 'token-a') =>
    ((await as(token).list(query).expect(200)).body as Page).items.map(
      (item) => item.post.id,
    );

  describe('POST /posts/:id/save', () => {
    it('answers 204 with no body and creates one row bound to the caller', async () => {
      await userA.save('post-1').expect(204, '');
      expect(saves).toEqual([
        expect.objectContaining({ user_id: 'user-a', post_id: 'post-1' }),
      ]);
    });

    it('is idempotent: a repeat leaves one row and keeps its created_at', async () => {
      await userA.save('post-1').expect(204);
      const first = saves[0].created_at;
      await userA.save('post-1').expect(204);
      expect(saves).toHaveLength(1);
      expect(saves[0].created_at).toEqual(first);
      expect(
        queryCalls.filter(({ sql }) => sql === SAVE_POST_SQL),
      ).toHaveLength(2);
    });

    it.each([
      ['missing', 'an unknown post'],
      ['post-in-deleted', 'a post in a deleted community'],
      ['post-in-suspended', 'a post in a suspended community'],
    ])('answers %s (%s) with 404, writing nothing', async (id) => {
      await userA.save(id).expect(404);
      expect(saves).toEqual([]);
    });

    it('answers a removed post with 404', async () => {
      posts[0].removed_at = new Date('2026-10-30T00:00:00.000Z');
      await userA.save('post-1').expect(404);
      expect(saves).toEqual([]);
    });

    it('answers 400 for a malformed id and 401 without a token', async () => {
      await userA.save('x%27%20OR%201%3D1').expect(400);
      await as().save('post-1').expect(401);
      await as('not-a-token').save('post-1').expect(401);
      expect(saves).toEqual([]);
    });

    it('saves your own post too, and needs no accepted rules', async () => {
      posts[0].author_id = 'user-a';
      await userA.save('post-1').expect(204);
    });
  });

  describe('DELETE /posts/:id/save', () => {
    it('removes the caller’s row only, with 204', async () => {
      await userA.save('post-1').expect(204);
      await userB.save('post-1').expect(204);
      await userA.unsave('post-1').expect(204, '');
      expect(saves.map((save) => save.user_id)).toEqual(['user-b']);
    });

    it('is idempotent: removing a save that does not exist is 204', async () => {
      await userA.unsave('post-1').expect(204);
      await userA.unsave('post-1').expect(204);
    });

    it('answers 404 for an unknown post, 400 for a malformed id, 401 without a token', async () => {
      await userA.unsave('missing').expect(404);
      await userA.unsave('x%27%20OR%201%3D1').expect(400);
      await as().unsave('post-1').expect(401);
    });

    it('drops a bookmark to a hidden post', async () => {
      await userA.save('post-1').expect(204);
      posts[0].removed_at = new Date();
      await userA.unsave('post-1').expect(204);
      expect(saves).toEqual([]);
    });
  });

  describe('GET /users/me/saved-posts', () => {
    it('lists by save time, newest first, with the envelope and the shared post type', async () => {
      await userA.save('post-2').expect(204);
      await userA.save('post-1').expect(204);
      await userA.save('post-3').expect(204);

      const response = await userA.list().expect(200);
      const body = response.body as Page;
      expect(body).toMatchObject({ page: 1, limit: 20, total: 3, sort: 'new' });
      expect(body.items.map((item) => item.post.id)).toEqual([
        'post-3',
        'post-1',
        'post-2',
      ]);
      expect(body.items[0]).toEqual({
        post: {
          id: 'post-3',
          title: 'Title post-3',
          content: 'Body',
          type: 'text',
          author_id: 'author',
          community_id: 'community-1',
          created_at: '2026-10-01T08:00:00.000Z',
          pinned_at: null,
          pinned_by: null,
          edited_at: null,
          locked_at: null,
          locked_by: null,
          score: 0,
          saved: true,
          media: null,
          flair: null,
        },
        saved_at: '2026-11-01T08:02:00.000Z',
      });
      expect(await listIds('?sort=oldest')).toEqual([
        'post-2',
        'post-1',
        'post-3',
      ]);
    });

    it('never returns another account’s saves', async () => {
      await userA.save('post-1').expect(204);
      await userB.save('post-2').expect(204);
      expect(await listIds('', 'token-a')).toEqual(['post-1']);
      expect(await listIds('', 'token-b')).toEqual(['post-2']);
      // Asking for someone else's list is not expressible.
      await userA.list('?user_id=user-b').expect(400);
    });

    it('answers an account without saves with an empty page', async () => {
      await expect(
        userA
          .list()
          .expect(200)
          .then((response) => response.body as Page),
      ).resolves.toEqual({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
        sort: 'new',
      });
    });

    it.each([
      '?page=0',
      '?page=10001',
      '?limit=0',
      '?limit=101',
      '?sort=top',
      '?unexpected=1',
    ])('rejects %s with 400', async (query) => {
      await userA.list(query).expect(400);
    });

    it('requires a token', async () => {
      await as().list().expect(401);
    });

    it('omits hidden posts, counts the same way, and keeps their rows so a restore reappears', async () => {
      // Seven saves: two will be hidden, one in each way.
      for (let index = 1; index <= 7; index += 1) {
        posts.push(post(`extra-${index}`));
        await userA.save(`extra-${index}`).expect(204);
      }
      posts.find((entry) => entry.id === 'extra-2')!.removed_at = new Date();
      posts.find((entry) => entry.id === 'extra-5')!.community_id =
        'community-suspended';

      // Paging through the whole list yields exactly total items, and the
      // last page is not empty.
      const first = (await userA.list('?limit=2').expect(200)).body as Page;
      expect(first.total).toBe(5);
      const seen: string[] = [];
      const pages = Math.ceil(first.total / 2);
      for (let page = 1; page <= pages; page += 1) {
        const body = (await userA.list(`?limit=2&page=${page}`).expect(200))
          .body as Page;
        expect(body.items.length).toBeGreaterThan(0);
        expect(body.total).toBe(first.total);
        seen.push(...body.items.map((item) => item.post.id));
      }
      expect(seen).toHaveLength(first.total);
      expect(new Set(seen).size).toBe(first.total);
      expect(seen).not.toContain('extra-2');
      expect(seen).not.toContain('extra-5');
      expect(
        (await userA.list('?limit=2&page=4').expect(200)).body,
      ).toMatchObject({ items: [], total: 5 });

      // The rows are kept; restoring the post brings it back.
      expect(saves.map((save) => save.post_id)).toContain('extra-2');
      posts.find((entry) => entry.id === 'extra-2')!.removed_at = null;
      expect(await listIds()).toContain('extra-2');
    });

    it('round-trips save, list, unsave, list', async () => {
      await userA.save('post-1').expect(204);
      expect(await listIds()).toEqual(['post-1']);
      await userA.unsave('post-1').expect(204);
      expect(await listIds()).toEqual([]);
    });
  });

  describe('saved on post responses', () => {
    // GET /posts does not enforce community suspension yet (see the README),
    // so the suspended community's post would be listed; keep the page to
    // the three ordinary posts.
    beforeEach(() => {
      posts = posts.filter((entry) => entry.id !== 'post-in-suspended');
    });

    it('is true only for the caller’s own saves, and false for an anonymous caller', async () => {
      await userA.save('post-1').expect(204);

      const savedOf = async (token?: string) => {
        const body = (await as(token).get('/posts').expect(200)).body as {
          items: { id: string; saved: boolean }[];
        };
        return Object.fromEntries(
          body.items.map((item) => [item.id, item.saved]),
        );
      };
      expect(await savedOf('token-a')).toEqual({
        'post-1': true,
        'post-2': false,
        'post-3': false,
      });
      expect(await savedOf('token-b')).toEqual({
        'post-1': false,
        'post-2': false,
        'post-3': false,
      });
      expect(await savedOf()).toEqual({
        'post-1': false,
        'post-2': false,
        'post-3': false,
      });

      await as('token-a')
        .get('/posts/post-1')
        .expect(200)
        .expect(({ body }) => expect(body).toMatchObject({ saved: true }));
      await as('token-b')
        .get('/posts/post-1')
        .expect(200)
        .expect(({ body }) => expect(body).toMatchObject({ saved: false }));
    });

    it('is one grouped lookup per page, bound to the caller, and none when anonymous', async () => {
      await as('token-a').get('/posts').expect(200);
      const lookups = queryCalls.filter(({ sql }) =>
        sql.startsWith('SELECT post_id FROM saved_posts'),
      );
      expect(lookups).toHaveLength(1);
      expect(lookups[0].values).toEqual([
        'user-a',
        'post-1',
        'post-2',
        'post-3',
      ]);

      queryCalls.length = 0;
      await as().get('/posts').expect(200);
      expect(
        queryCalls.some(({ sql }) =>
          sql.startsWith('SELECT post_id FROM saved_posts'),
        ),
      ).toBe(false);
    });
  });

  it('never serialises an email, a password hash or a save count', async () => {
    await userA.save('post-1').expect(204);
    const bodies = [
      (await userA.list().expect(200)).body,
      (await userA.get('/posts').expect(200)).body,
      (await userA.get('/posts/post-1').expect(200)).body,
    ];
    for (const body of bodies) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/email|password_hash|leak/);
      expect(text).not.toMatch(/save_count|saved_count|saves/);
    }
  });
});
