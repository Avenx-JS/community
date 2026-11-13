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
import { REMOVED_CONTENT_REVIEWER_SQL } from '../src/common/removed-content';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import {
  COMMENT_REVISION_SUBJECT_SQL,
  COMMENT_REVISIONS_SQL,
  COMMENT_REVISIONS_SUMMARY_SQL,
  POST_REVISION_SUBJECT_SQL,
  POST_REVISIONS_SQL,
  POST_REVISIONS_SUMMARY_SQL,
} from '../src/posts/content-revisions.service';
import {
  HIDDEN_POSTS_COUNT_SQL,
  HIDE_POST_SQL,
  hiddenPostsSql,
  UNHIDE_POST_SQL,
} from '../src/posts/hidden-posts.service';
import {
  LABEL_POST_SQL,
  SET_LABEL_SQL,
} from '../src/posts/post-labels.service';
import {
  INSERT_POST_REVISION_SQL,
  NOT_HIDDEN_BY_VIEWER_SQL,
  POST_COLUMNS,
  REMOVAL_COLUMNS,
} from '../src/posts/posts.service';
import {
  ANY_COMMENT_SQL,
  SAVE_COMMENT_SQL,
  SAVEABLE_COMMENT_SQL,
  SAVED_COMMENTS_COUNT_SQL,
  savedCommentsSql,
  UNSAVE_COMMENT_SQL,
} from '../src/posts/saved-comments.service';
import {
  ANY_POST_SQL,
  SAVEABLE_POST_SQL,
} from '../src/posts/saved-posts.service';
import {
  VOTED_COMMENTS_COUNT_SQL,
  VOTED_COMMENTS_SQL,
  VOTED_POSTS_COUNT_SQL,
  VOTED_POSTS_SQL,
} from '../src/posts/vote-history.service';
import { answerSavedFlags } from './fakes/saved-posts';
import { answerVoteScores } from './fakes/vote-scores';

interface Post {
  id: string;
  title: string;
  content: string;
  author_id: string;
  created_at: Date;
  edited_at: Date | null;
  removed_at: Date | null;
  nsfw_set_by: 'author' | 'moderator' | null;
  spoiler_set_by: 'author' | 'moderator' | null;
}

// Migration 039 end to end, over a fake database that keeps the state the
// new statements read and write. One public community; u-mod moderates it.
describe('Labels, own views and revisions (e2e)', () => {
  let app: INestApplication<App>;
  let posts: Post[];
  let comment: { id: string; removed_at: Date | null; content: string };
  let hidden: Set<string>;
  let savedComments: Set<string>;
  let votes: Array<{
    user: string;
    type: 'post' | 'comment';
    id: string;
    value: number;
  }>;
  let revisions: Array<{
    post_id: string;
    title: string;
    content: string;
    version_at: Date;
    replaced_at: Date;
  }>;

  const users: Record<string, string> = {
    'u-author': 'author',
    'u-mod': 'mod',
    'u-reader': 'reader',
  };
  const post = (id: string) => posts.find((entry) => entry.id === id);
  const row = (entry: Post) => ({
    ...entry,
    type: 'text',
    community_id: 'c-1',
    pinned_at: null,
    pinned_by: null,
    locked_at: null,
    locked_by: null,
    media_id: null,
    flair_id: null,
    removed_by: null,
    removal_reason: null,
  });
  const key = (user: unknown, id: unknown) => `${String(user)}:${String(id)}`;

  beforeEach(async () => {
    posts = [
      {
        id: 'p-1',
        title: 'Seed swap',
        content: 'Tomatoes',
        author_id: 'u-author',
        created_at: new Date('2026-11-01T10:00:00Z'),
        edited_at: null,
        removed_at: null,
        nsfw_set_by: null,
        spoiler_set_by: null,
      },
      {
        id: 'p-2',
        title: 'Compost',
        content: 'Leaves',
        author_id: 'u-author',
        created_at: new Date('2026-11-02T10:00:00Z'),
        edited_at: null,
        removed_at: null,
        nsfw_set_by: null,
        spoiler_set_by: null,
      },
    ];
    comment = { id: 'c-1', removed_at: null, content: 'Nice' };
    hidden = new Set();
    savedComments = new Set();
    votes = [
      { user: 'u-reader', type: 'post', id: 'p-1', value: 1 },
      { user: 'u-reader', type: 'post', id: 'p-2', value: -1 },
      { user: 'u-reader', type: 'comment', id: 'c-1', value: 1 },
    ];
    revisions = [];
    let clock = Date.parse('2026-11-05T10:00:00Z');

    const run = (sql: string, values: unknown[]): [unknown, unknown] => {
      const rows = (value: unknown): [unknown, unknown] => [value, []];
      const flat = sql.replace(/\s+/g, ' ').trim();
      const score = answerVoteScores(sql, values);
      if (score) return score;
      const saved = answerSavedFlags(sql, values);
      if (saved) return saved;

      // Listings: GET /posts, with the caller's hidden posts left out.
      if (
        flat.startsWith(`SELECT ${POST_COLUMNS} FROM posts WHERE`) ||
        flat.startsWith('SELECT COUNT(*) AS total FROM posts WHERE')
      ) {
        const viewer = sql.includes(NOT_HIDDEN_BY_VIEWER_SQL)
          ? values[1]
          : null;
        const listed = posts.filter(
          (entry) => !entry.removed_at && !hidden.has(key(viewer, entry.id)),
        );
        return flat.startsWith('SELECT COUNT(*)')
          ? rows([{ total: listed.length }])
          : rows(listed.map(row));
      }
      if (
        sql.startsWith(
          `SELECT ${POST_COLUMNS}, ${REMOVAL_COLUMNS} FROM posts WHERE id = ?`,
        )
      ) {
        const entry = post(values[0] as string);
        return rows(entry ? [row(entry)] : []);
      }
      if (sql === REMOVED_CONTENT_REVIEWER_SQL) {
        return rows([{ can_review: values[1] === 'u-mod' ? 1 : 0 }]);
      }

      // Editing.
      if (
        flat.startsWith(
          'SELECT id, author_id, type, title, content, created_at, edited_at',
        )
      ) {
        const entry = post(values[0] as string);
        return rows(entry ? [{ ...row(entry) }] : []);
      }
      if (flat.includes('FROM community_bans')) return rows([]);
      if (sql === INSERT_POST_REVISION_SQL) {
        const [, postId, title, content, versionAt] = values;
        revisions.push({
          post_id: postId as string,
          title: title as string,
          content: content as string,
          version_at: versionAt as Date,
          replaced_at: new Date(clock),
        });
        return rows({ affectedRows: 1 });
      }
      if (
        flat.startsWith('UPDATE posts SET') &&
        flat.includes('edited_at = UTC_TIMESTAMP()')
      ) {
        const entry = post(values.at(-1) as string)!;
        const columns = [...sql.matchAll(/(title|content) = \?/g)].map(
          (m) => m[1] as 'title' | 'content',
        );
        columns.forEach((column, index) => {
          entry[column] = values[index] as string;
        });
        entry.edited_at = new Date(clock);
        clock += 60_000;
        return rows({ affectedRows: 1 });
      }
      if (sql === `SELECT ${POST_COLUMNS} FROM posts WHERE id = ? LIMIT 1`) {
        const entry = post(values[0] as string);
        return rows(entry ? [row(entry)] : []);
      }

      // Labels.
      if (sql === LABEL_POST_SQL) {
        const [actor, , postId] = values;
        const entry = post(postId as string);
        return rows(
          entry
            ? [{ ...row(entry), can_moderate: actor === 'u-mod' ? 1 : 0 }]
            : [],
        );
      }
      for (const label of ['nsfw', 'spoiler'] as const) {
        if (sql === SET_LABEL_SQL[label]) {
          post(values[1] as string)![`${label}_set_by`] =
            values[0] as Post['nsfw_set_by'];
          return rows({ affectedRows: 1 });
        }
      }

      // Hiding.
      if (sql === SAVEABLE_POST_SQL) {
        const entry = post(values[0] as string);
        return rows(entry && !entry.removed_at ? [{ id: entry.id }] : []);
      }
      if (sql === ANY_POST_SQL) {
        return rows(post(values[0] as string) ? [{ id: values[0] }] : []);
      }
      if (sql === HIDE_POST_SQL) {
        hidden.add(key(values[0], values[1]));
        return rows({ affectedRows: 1 });
      }
      if (sql === UNHIDE_POST_SQL) {
        hidden.delete(key(values[0], values[1]));
        return rows({ affectedRows: 1 });
      }
      if (sql === hiddenPostsSql('new') || sql === HIDDEN_POSTS_COUNT_SQL) {
        const own = posts.filter(
          (entry) => !entry.removed_at && hidden.has(key(values[0], entry.id)),
        );
        return sql === HIDDEN_POSTS_COUNT_SQL
          ? rows([{ total: own.length }])
          : rows(
              own.map((entry) => ({
                ...row(entry),
                hidden_at: new Date('2026-11-06T10:00:00Z'),
              })),
            );
      }

      // Saved comments.
      const commentRow = () => ({
        id: comment.id,
        post_id: 'p-1',
        content: comment.content,
        created_at: new Date('2026-11-03T10:00:00Z'),
        edited_at: null,
        post_title: 'Seed swap',
        community_name: 'garden',
      });
      if (sql === SAVEABLE_COMMENT_SQL) {
        return rows(
          values[0] === comment.id && !comment.removed_at
            ? [{ id: comment.id }]
            : [],
        );
      }
      if (sql === ANY_COMMENT_SQL) {
        return rows(values[0] === comment.id ? [{ id: comment.id }] : []);
      }
      if (sql === SAVE_COMMENT_SQL) {
        savedComments.add(key(values[0], values[1]));
        return rows({ affectedRows: 1 });
      }
      if (sql === UNSAVE_COMMENT_SQL) {
        savedComments.delete(key(values[0], values[1]));
        return rows({ affectedRows: 1 });
      }
      if (sql === savedCommentsSql('new') || sql === SAVED_COMMENTS_COUNT_SQL) {
        const listed =
          savedComments.has(key(values[0], comment.id)) && !comment.removed_at;
        return sql === SAVED_COMMENTS_COUNT_SQL
          ? rows([{ total: listed ? 1 : 0 }])
          : rows(
              listed
                ? [
                    {
                      ...commentRow(),
                      saved_at: new Date('2026-11-06T10:00:00Z'),
                    },
                  ]
                : [],
            );
      }

      // Votes.
      const voted = (type: 'post' | 'comment') =>
        votes.filter(
          (vote) =>
            vote.user === values[0] &&
            vote.type === type &&
            vote.value === values[1] &&
            (type === 'post'
              ? !post(vote.id)?.removed_at
              : !comment.removed_at),
        );
      if (sql === VOTED_POSTS_COUNT_SQL)
        return rows([{ total: voted('post').length }]);
      if (sql === VOTED_COMMENTS_COUNT_SQL)
        return rows([{ total: voted('comment').length }]);
      if (sql === VOTED_POSTS_SQL) {
        return rows(
          voted('post').map((vote) => ({
            ...row(post(vote.id)!),
            voted_at: new Date('2026-11-04T10:00:00Z'),
          })),
        );
      }
      if (sql === VOTED_COMMENTS_SQL) {
        return rows(
          voted('comment').map(() => ({
            ...commentRow(),
            voted_at: new Date('2026-11-04T10:00:00Z'),
          })),
        );
      }

      // Revisions.
      if (sql === POST_REVISION_SUBJECT_SQL) {
        const entry = post(values[0] as string);
        return rows(
          entry ? [{ ...row(entry), removed: entry.removed_at ? 1 : 0 }] : [],
        );
      }
      if (sql === POST_REVISIONS_SQL) {
        return rows(
          revisions
            .filter((revision) => revision.post_id === values[0])
            .reverse(),
        );
      }
      if (sql === POST_REVISIONS_SUMMARY_SQL) {
        const own = revisions.filter(
          (revision) => revision.post_id === values[0],
        );
        return rows([
          { total: own.length, first_version_at: own[0]?.version_at ?? null },
        ]);
      }
      if (sql === COMMENT_REVISION_SUBJECT_SQL) {
        return rows(
          values[0] === comment.id
            ? [
                {
                  community_id: 'c-1',
                  content: comment.content,
                  created_at: new Date('2026-11-03T10:00:00Z'),
                  edited_at: new Date('2026-11-03T12:00:00Z'),
                  removed: comment.removed_at ? 1 : 0,
                },
              ]
            : [],
        );
      }
      if (sql === COMMENT_REVISIONS_SQL) return rows([]);
      if (sql === COMMENT_REVISIONS_SUMMARY_SQL)
        return rows([{ total: 0, first_version_at: null }]);

      throw new Error(`Unexpected SQL: ${flat}`);
    };
    const execute = (sql: string, values: unknown[] = []) =>
      Promise.resolve(run(sql, values));

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute,
        getConnection: () =>
          Promise.resolve({
            execute,
            beginTransaction: () => Promise.resolve(),
            commit: () => Promise.resolve(),
            rollback: () => Promise.resolve(),
            release: () => undefined,
          }),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) => {
          const id = `u-${token.replace(/-token$/, '')}`;
          return Promise.resolve(
            users[id]
              ? { kind: 'valid', emailVerified: true, userId: id }
              : { kind: 'invalid' },
          );
        },
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
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

  const as = (who: string) => {
    const auth = { Authorization: `Bearer ${who}-token` };
    const server = app.getHttpServer();
    return {
      get: (path: string) => request(server).get(path).set(auth),
      post: (path: string) => request(server).post(path).set(auth),
      put: (path: string) => request(server).put(path).set(auth),
      patch: (path: string) => request(server).patch(path).set(auth),
      delete: (path: string) => request(server).delete(path).set(auth),
    };
  };
  const anonymous = () => request(app.getHttpServer());
  const ids = (body: unknown) =>
    (
      body as { items: Array<{ id?: string; post?: { id: string } }> }
    ).items.map((item) => item.id ?? item.post?.id);

  describe('labels', () => {
    it('lets the author label a post, and shows it on the post', async () => {
      await as('author').put('/posts/p-1/nsfw').expect(204);
      const read = await anonymous().get('/posts/p-1').expect(200);
      expect(read.body).toMatchObject({ nsfw: true, spoiler: false });
      await as('author').delete('/posts/p-1/nsfw').expect(204);
      expect(post('p-1')!.nsfw_set_by).toBeNull();
    });

    it("keeps a moderator's label from the author", async () => {
      await as('mod').put('/posts/p-1/spoiler').expect(204);
      expect(post('p-1')!.spoiler_set_by).toBe('moderator');
      await as('author').put('/posts/p-1/spoiler').expect(204);
      expect(post('p-1')!.spoiler_set_by).toBe('moderator');
      await as('author').delete('/posts/p-1/spoiler').expect(403);
      await as('mod').delete('/posts/p-1/spoiler').expect(204);
      expect(post('p-1')!.spoiler_set_by).toBeNull();
    });

    it('refuses everyone else', async () => {
      await as('reader').put('/posts/p-1/nsfw').expect(403);
      await anonymous().put('/posts/p-1/nsfw').expect(401);
      await as('author').put('/posts/missing/nsfw').expect(404);
    });
  });

  describe('hiding', () => {
    it("takes a post out of the caller's listing only, keeping its permalink", async () => {
      await as('reader').post('/posts/p-1/hide').expect(204);
      await as('reader').post('/posts/p-1/hide').expect(204);

      expect(ids((await as('reader').get('/posts').expect(200)).body)).toEqual([
        'p-2',
      ]);
      expect(ids((await as('author').get('/posts').expect(200)).body)).toEqual([
        'p-1',
        'p-2',
      ]);
      expect(ids((await anonymous().get('/posts').expect(200)).body)).toEqual([
        'p-1',
        'p-2',
      ]);
      await as('reader').get('/posts/p-1').expect(200);

      const own = await as('reader').get('/users/me/hidden-posts').expect(200);
      expect(own.body).toMatchObject({ total: 1, sort: 'new' });
      expect(ids(own.body)).toEqual(['p-1']);

      await as('reader').delete('/posts/p-1/hide').expect(204);
      expect(ids((await as('reader').get('/posts').expect(200)).body)).toEqual([
        'p-1',
        'p-2',
      ]);
    });

    it('is 404 for a removed post, and private', async () => {
      post('p-1')!.removed_at = new Date();
      await as('reader').post('/posts/p-1/hide').expect(404);
      await anonymous().get('/users/me/hidden-posts').expect(401);
    });
  });

  describe('saved comments', () => {
    it('saves, lists, omits once removed and unsaves', async () => {
      await as('reader').post('/comments/c-1/save').expect(204);
      const listed = await as('reader')
        .get('/users/me/saved-comments')
        .expect(200);
      expect(listed.body).toMatchObject({
        total: 1,
        items: [
          {
            comment: {
              id: 'c-1',
              post_title: 'Seed swap',
              community_name: 'garden',
            },
          },
        ],
      });
      // Like saved posts: a removed comment is omitted, its save kept.
      comment.removed_at = new Date();
      expect(
        (await as('reader').get('/users/me/saved-comments').expect(200)).body,
      ).toMatchObject({ total: 0 });
      expect(savedComments.size).toBe(1);
      await as('reader').delete('/comments/c-1/save').expect(204);
      expect(savedComments.size).toBe(0);
      await as('reader').post('/comments/c-1/save').expect(404);
    });
  });

  describe('own votes', () => {
    it('lists upvoted and downvoted content, privately, without removed content', async () => {
      const up = await as('reader').get('/users/me/upvoted').expect(200);
      expect(up.body).toMatchObject({ type: 'posts', total: 1 });
      expect(ids(up.body)).toEqual(['p-1']);
      const down = await as('reader').get('/users/me/downvoted').expect(200);
      expect(ids(down.body)).toEqual(['p-2']);
      const comments = await as('reader')
        .get('/users/me/upvoted?type=comments')
        .expect(200);
      expect(comments.body).toMatchObject({
        type: 'comments',
        items: [{ comment: { id: 'c-1' } }],
      });

      post('p-1')!.removed_at = new Date();
      expect(
        (await as('reader').get('/users/me/upvoted').expect(200)).body,
      ).toMatchObject({ total: 0 });
      expect(
        (await as('author').get('/users/me/upvoted').expect(200)).body,
      ).toMatchObject({ total: 0 });
      await anonymous().get('/users/me/upvoted').expect(401);
      await as('reader').get('/users/me/upvoted?type=users').expect(400);
    });
  });

  describe('revisions', () => {
    it('keeps every replaced version, apart from the current one', async () => {
      await as('author')
        .patch('/posts/p-1')
        .send({ title: 'Seed swap!' })
        .expect(200);
      await as('author')
        .patch('/posts/p-1')
        .send({ content: 'Tomatoes, beans' })
        .expect(200);

      const history = await anonymous().get('/posts/p-1/revisions').expect(200);
      expect(history.body).toMatchObject({
        current: {
          title: 'Seed swap!',
          content: 'Tomatoes, beans',
          edited: true,
        },
        total: 2,
        complete: true,
        items: [
          { title: 'Seed swap!', content: 'Tomatoes' },
          {
            title: 'Seed swap',
            content: 'Tomatoes',
            version_at: '2026-11-01T10:00:00.000Z',
          },
        ],
      });
      // The current version was written when the latest earlier one was
      // replaced: the two timestamps line up, and are never mixed.
      const body = history.body as {
        current: { version_at: string };
        items: Array<{ version_at: string; replaced_at: string }>;
      };
      expect(body.current.version_at).toBe(body.items[0].replaced_at);
      expect(body.items[0].version_at).toBe(body.items[1].replaced_at);
    });

    it("shows a removed post's history only to its reviewers", async () => {
      post('p-1')!.removed_at = new Date();
      await anonymous().get('/posts/p-1/revisions').expect(404);
      await as('reader').get('/posts/p-1/revisions').expect(404);
      await as('mod').get('/posts/p-1/revisions').expect(200);
    });

    it('says when edits before history was kept left nothing', async () => {
      const history = await anonymous()
        .get('/comments/c-1/revisions')
        .expect(200);
      expect(history.body).toMatchObject({
        current: { title: null, content: 'Nice', edited: true },
        items: [],
        complete: false,
      });
      comment.removed_at = new Date();
      await anonymous().get('/comments/c-1/revisions').expect(404);
    });
  });
});
