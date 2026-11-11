import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import sharp from 'sharp';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { CommunityModerationLogService } from '../src/communities/community-moderation-log.service';
import { CommunityRuleAcceptanceService } from '../src/communities/community-rule-acceptance.service';
import { MediaCleanupService } from '../src/media/media-cleanup.service';
import { MEDIA_CONFIG, readMediaConfig } from '../src/media/media.config';
import {
  DELETE_RELEASED_MEDIA_SQL,
  INSERT_MEDIA_SQL,
  LOCK_OWN_UPLOAD_SQL,
  LOCK_UPLOADER_SQL,
  MEDIA_COLUMNS,
  PENDING_UPLOADS_SQL,
  RELEASED_MEDIA_SQL,
  RELEASE_MEDIA_SQL,
  RELEASE_POST_MEDIA_SQL,
  RELEASE_STALE_UPLOADS_SQL,
  VISIBLE_MEDIA_SQL,
} from '../src/media/media-sql';
import { MEDIA_STORAGE } from '../src/media/storage/media-storage';
import { NotificationsService } from '../src/notifications/notifications.service';
import { POST_COLUMNS, REMOVAL_COLUMNS } from '../src/posts/posts.service';
import { USER_PROFILE_SQL } from '../src/users/users.service';
import { answerSavedFlags } from './fakes/saved-posts';
import { answerVoteScores } from './fakes/vote-scores';

interface MediaRecord {
  id: string;
  uploader_id: string | null;
  purpose: string;
  kind: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  storage_key: string;
  created_at: Date;
  released_at: Date | null;
}

interface PostRecord {
  id: string;
  title: string;
  content: string | null;
  type: string;
  author_id: string;
  community_id: string;
  created_at: Date;
  media_id: string | null;
  removed_at: Date | null;
}

// POST/GET/DELETE /media, media posts, avatars, community icons and banners,
// and the cleanup sweep, over HTTP. Uploads are real multipart requests,
// processed by the real sharp pipeline; the database is an in-memory model
// of the media statements, and storage an in-memory map.
describe('Media (e2e)', () => {
  let app: INestApplication<App>;
  let media: MediaRecord[];
  let posts: PostRecord[];
  let users: Array<{
    id: string;
    username: string;
    deleted_at: Date | null;
    avatar_media_id: string | null;
  }>;
  let communities: Array<{
    id: string;
    name: string;
    creator_id: string;
    icon_media_id: string | null;
    banner_media_id: string | null;
    hidden: boolean;
  }>;
  let objects: Map<string, Buffer>;
  let logged: jest.Mock;

  const referenced = (id: string) =>
    posts.some((post) => post.media_id === id) ||
    users.some((user) => user.avatar_media_id === id) ||
    communities.some(
      (community) =>
        community.icon_media_id === id || community.banner_media_id === id,
    );
  const visibleTo = (row: MediaRecord, viewer: string | null) =>
    !row.released_at &&
    (posts.some(
      (post) =>
        post.media_id === row.id &&
        !post.removed_at &&
        !communities.find((c) => c.id === post.community_id)?.hidden,
    ) ||
      users.some(
        (user) => user.avatar_media_id === row.id && !user.deleted_at,
      ) ||
      communities.some(
        (c) =>
          !c.hidden &&
          (c.icon_media_id === row.id || c.banner_media_id === row.id),
      ) ||
      (viewer !== null && row.uploader_id === viewer));
  const pending = (uploader: string) =>
    media.filter(
      (row) =>
        row.uploader_id === uploader &&
        !row.released_at &&
        row.purpose === 'post' &&
        !posts.some((post) => post.media_id === row.id),
    );
  const release = (id: string | null | undefined) => {
    const row = media.find((entry) => entry.id === id && !entry.released_at);
    if (row) {
      row.released_at = new Date();
    }
    return [{ affectedRows: row ? 1 : 0 }, []];
  };
  const mediaColumns = (row: MediaRecord) => {
    const { released_at: _released, ...columns } = row;
    void _released;
    return columns;
  };

  beforeEach(async () => {
    media = [];
    posts = [];
    users = [
      {
        id: 'u-alice',
        username: 'alice',
        deleted_at: null,
        avatar_media_id: null,
      },
      { id: 'u-bob', username: 'bob', deleted_at: null, avatar_media_id: null },
    ];
    communities = [
      {
        id: 'c-garden',
        name: 'garden',
        creator_id: 'u-alice',
        icon_media_id: null,
        banner_media_id: null,
        hidden: false,
      },
    ];
    objects = new Map();
    logged = jest.fn(() => Promise.resolve());

    const execute = (sql: string, values: unknown[] = []): unknown => {
      const scores = answerVoteScores(sql, values);
      if (scores) return scores;
      const flags = answerSavedFlags(sql, values);
      if (flags) return flags;
      if (sql.includes('FROM community_bans')) return [[], []];

      // Uploads.
      if (sql === LOCK_UPLOADER_SQL) {
        return [users.filter((u) => u.id === values[0] && !u.deleted_at), []];
      }
      if (sql === PENDING_UPLOADS_SQL) {
        return [[{ pending: pending(values[0] as string).length }], []];
      }
      if (sql === INSERT_MEDIA_SQL) {
        const [
          id,
          uploader_id,
          purpose,
          kind,
          mime_type,
          size_bytes,
          width,
          height,
          storage_key,
        ] = values as [
          string,
          string,
          string,
          string,
          string,
          number,
          number | null,
          number | null,
          string,
        ];
        media.push({
          id,
          uploader_id,
          purpose,
          kind,
          mime_type,
          size_bytes,
          width,
          height,
          storage_key,
          created_at: new Date(),
          released_at: null,
        });
        return [{ affectedRows: 1 }, []];
      }
      if (sql === VISIBLE_MEDIA_SQL) {
        const [id, viewer] = values as [string, string | null];
        return [
          media
            .filter((row) => row.id === id && visibleTo(row, viewer))
            .map(mediaColumns),
          [],
        ];
      }
      if (
        sql.startsWith(`SELECT ${MEDIA_COLUMNS} FROM media WHERE media.id IN`)
      ) {
        return [
          media.filter((row) => values.includes(row.id)).map(mediaColumns),
          [],
        ];
      }
      if (sql === LOCK_OWN_UPLOAD_SQL) {
        return [
          media
            .filter((row) => row.id === values[0])
            .map((row) => ({
              ...row,
              attached: posts.some((p) => p.media_id === row.id) ? 1 : 0,
            })),
          [],
        ];
      }
      // POST /posts attaching an upload.
      if (sql.startsWith(`SELECT ${MEDIA_COLUMNS}, media.released_at,`)) {
        return [
          media
            .filter((row) => row.id === values[0])
            .map((row) => ({
              ...row,
              attached: posts.some((p) => p.media_id === row.id) ? 1 : 0,
            })),
          [],
        ];
      }
      if (sql === RELEASE_MEDIA_SQL) return release(values[0] as string);
      if (sql === RELEASE_POST_MEDIA_SQL) {
        return release(posts.find((post) => post.id === values[0])?.media_id);
      }

      // Avatars.
      if (sql.startsWith('SELECT avatar_media_id FROM users WHERE id = ?')) {
        return [
          users
            .filter((u) => u.id === values[0] && !u.deleted_at)
            .map(({ avatar_media_id }) => ({ avatar_media_id })),
          [],
        ];
      }
      if (sql === 'UPDATE users SET avatar_media_id = ? WHERE id = ?') {
        users.find((u) => u.id === values[1])!.avatar_media_id =
          values[0] as string;
        return [{ affectedRows: 1 }, []];
      }
      if (sql === 'UPDATE users SET avatar_media_id = NULL WHERE id = ?') {
        users.find((u) => u.id === values[0])!.avatar_media_id = null;
        return [{ affectedRows: 1 }, []];
      }
      if (sql === USER_PROFILE_SQL) {
        return [
          users
            .filter((u) => u.username === values[0] && !u.deleted_at)
            .map((u) => ({
              username: u.username,
              display_name: null,
              bio: null,
              created_at: new Date('2026-01-01T00:00:00Z'),
              avatar_media_id: u.avatar_media_id,
            })),
          [],
        ];
      }

      // Community images.
      if (
        sql.startsWith(
          'SELECT id, creator_id, icon_media_id, banner_media_id FROM communities WHERE name = ?',
        )
      ) {
        return [
          communities.filter((c) => c.name === values[0] && !c.hidden),
          [],
        ];
      }
      const slot =
        /^UPDATE communities SET (icon|banner)_media_id = (\?|NULL) WHERE id = \?$/.exec(
          sql,
        );
      if (slot) {
        const community = communities.find((c) => c.id === values.at(-1))!;
        community[`${slot[1] as 'icon' | 'banner'}_media_id`] =
          slot[2] === '?' ? (values[0] as string) : null;
        return [{ affectedRows: 1 }, []];
      }
      if (
        sql.startsWith(
          'SELECT id, creator_id, name, description, created_at, icon_media_id, banner_media_id FROM communities WHERE name = ?',
        )
      ) {
        return [
          communities
            .filter((c) => c.name === values[0] && !c.hidden)
            .map((c) => ({
              ...c,
              description: null,
              created_at: new Date('2026-01-01T00:00:00Z'),
            })),
          [],
        ];
      }

      // Posts.
      if (sql.startsWith('SELECT id FROM communities WHERE id = ?')) {
        return [
          communities
            .filter((c) => c.id === values[0] && !c.hidden)
            .map(({ id }) => ({ id })),
          [],
        ];
      }
      if (sql.startsWith('INSERT INTO posts')) {
        const [id, title, content, type, author_id, community_id, media_id] =
          values as [
            string,
            string,
            string | null,
            string,
            string,
            string,
            string | null,
          ];
        if (media_id && posts.some((p) => p.media_id === media_id)) {
          throw Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' });
        }
        posts.push({
          id,
          title,
          content,
          type,
          author_id,
          community_id,
          media_id,
          created_at: new Date('2026-11-11T10:00:00Z'),
          removed_at: null,
        });
        return [{ affectedRows: 1 }, []];
      }
      const postRow = (post: PostRecord) => ({
        ...post,
        pinned_at: null,
        pinned_by: null,
        edited_at: null,
        locked_at: null,
        locked_by: null,
        removed_by: null,
        removal_reason: null,
      });
      if (
        sql === `SELECT ${POST_COLUMNS} FROM posts WHERE id = ? LIMIT 1` ||
        sql.startsWith(
          `SELECT ${POST_COLUMNS}, ${REMOVAL_COLUMNS} FROM posts WHERE id = ?`,
        )
      ) {
        return [posts.filter((p) => p.id === values[0]).map(postRow), []];
      }
      if (
        sql.startsWith(
          'SELECT posts.id, posts.author_id, posts.community_id, posts.title,',
        )
      ) {
        return [
          posts
            .filter((p) => p.id === values[2])
            .map((p) => ({ ...p, can_moderate: 0 })),
          [],
        ];
      }
      if (sql === 'DELETE FROM posts WHERE id = ?') {
        posts = posts.filter((p) => p.id !== values[0]);
        return [{ affectedRows: 1 }, []];
      }

      // The sweep.
      if (sql === RELEASE_STALE_UPLOADS_SQL) {
        const cutoff = Date.now() - Number(values[0]) * 3600_000;
        let affectedRows = 0;
        for (const row of media) {
          if (
            !row.released_at &&
            row.created_at.getTime() < cutoff &&
            !referenced(row.id)
          ) {
            row.released_at = new Date();
            affectedRows += 1;
          }
        }
        return [{ affectedRows }, []];
      }
      if (sql === RELEASED_MEDIA_SQL) {
        return [
          media
            .filter((row) => row.released_at && !referenced(row.id))
            .slice(0, Number(values[0]))
            .map(({ id, storage_key }) => ({ id, storage_key })),
          [],
        ];
      }
      if (sql === DELETE_RELEASED_MEDIA_SQL) {
        const before = media.length;
        media = media.filter(
          (row) =>
            !(row.id === values[0] && row.released_at && !referenced(row.id)),
        );
        return [{ affectedRows: before - media.length }, []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    const promised = (sql: string, values?: unknown[]) => {
      try {
        return Promise.resolve(execute(sql, values));
      } catch (error) {
        return Promise.reject(error as Error);
      }
    };
    const pool = {
      execute: promised,
      query: promised,
      getConnection: () =>
        Promise.resolve({
          execute: promised,
          query: promised,
          beginTransaction: () => Promise.resolve(),
          commit: () => Promise.resolve(),
          rollback: () => Promise.resolve(),
          release: () => undefined,
        }),
    };
    const tokens: Record<string, string> = {
      'alice-token': 'u-alice',
      'bob-token': 'u-bob',
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue(pool)
      .overrideProvider(MEDIA_STORAGE)
      .useValue({
        put: (key: string, body: Buffer) => {
          objects.set(key, body);
          return Promise.resolve();
        },
        get: (key: string) => Promise.resolve(objects.get(key) ?? null),
        delete: (key: string) => {
          objects.delete(key);
          return Promise.resolve();
        },
      })
      .overrideProvider(MEDIA_CONFIG)
      .useValue({
        ...readMediaConfig({}),
        pendingMax: 2,
        sweepIntervalSeconds: 0,
      })
      .overrideProvider(CommunityModerationLogService)
      .useValue({ record: logged })
      .overrideProvider(CommunityRuleAcceptanceService)
      .useValue({ assertAcceptedOrThrow: () => Promise.resolve() })
      .overrideProvider(NotificationsService)
      .useValue({
        recordCommunityPost: () =>
          Promise.resolve({ recipients: 0, written: false }),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(
            token in tokens
              ? { kind: 'valid', userId: tokens[token] }
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
    await app.get(MediaCleanupService).sweep();
    await app.close();
  });

  const server = () => request(app.getHttpServer());
  const auth = <T extends { set: (k: string, v: string) => T }>(
    call: T,
    token: string | null,
  ) => (token ? call.set('Authorization', `Bearer ${token}`) : call);
  const upload = (
    file: Buffer,
    options: {
      path?: string;
      method?: 'post' | 'put';
      token?: string | null;
      field?: string;
      contentType?: string;
    } = {},
  ) => {
    const call = server()[options.method ?? 'post'](options.path ?? '/media');
    return auth(
      call,
      options.token === undefined ? 'alice-token' : options.token,
    ).attach(options.field ?? 'file', file, {
      filename: 'upload.bin',
      contentType: options.contentType ?? 'image/png',
    });
  };
  const get = (path: string, token: string | null = null) =>
    auth(server().get(path), token);
  const sweep = () => app.get(MediaCleanupService).sweep();

  const photo = () =>
    sharp({
      create: { width: 40, height: 20, channels: 3, background: '#2266aa' },
    })
      .withExif({ IFD0: { Model: 'Secret Phone 9' } })
      .jpeg()
      .toBuffer();

  async function uploaded(token = 'alice-token') {
    const response = await upload(await photo(), { token }).expect(201);
    return response.body as { id: string; url: string };
  }

  describe('POST /media', () => {
    it('requires a token', async () => {
      await upload(await photo(), { token: null }).expect(401);
      expect(objects.size).toBe(0);
    });

    it('stores a re-encoded image without its metadata, and answers with its metadata', async () => {
      const body: unknown = (
        await upload(await photo(), {
          contentType: 'application/octet-stream',
        }).expect(201)
      ).body;
      const id = (body as { id: string }).id;
      expect(body).toEqual({
        id,
        kind: 'image',
        mime_type: 'image/jpeg',
        size_bytes: expect.any(Number) as unknown,
        width: 40,
        height: 20,
        url: `/media/${id}/file`,
        created_at: expect.any(String) as unknown,
      });
      expect(media).toMatchObject([
        { id, uploader_id: 'u-alice', purpose: 'post', released_at: null },
      ]);
      const [stored] = [...objects.values()];
      expect(stored.includes(Buffer.from('Secret Phone'))).toBe(false);
      expect((await sharp(stored).metadata()).exif).toBeUndefined();
      expect(JSON.stringify(body)).not.toMatch(/storage_key|u-alice|\.jpg/);
    });

    // The type comes from the bytes, never from the client.
    it.each([
      [
        'an HTML page labelled image/png',
        Buffer.from('<html><script>alert(1)</script></html>'),
        'image/png',
        415,
      ],
      [
        'an SVG labelled image/svg+xml',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'image/svg+xml',
        415,
      ],
      [
        'bytes that only start like a PNG',
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from('junk'),
        ]),
        'image/png',
        400,
      ],
    ])(
      'refuses %s with %s… and stores nothing',
      async (_name, file, contentType, status) => {
        await upload(file, { contentType }).expect(status);
        expect(objects.size).toBe(0);
        expect(media).toEqual([]);
      },
    );

    it('refuses a file above MEDIA_MAX_BYTES with 413', async () => {
      const limit = readMediaConfig({}).maxBytes;
      await upload(Buffer.alloc(limit + 1, 0xff)).expect(413);
      expect(objects.size).toBe(0);
    });

    it('refuses a request without the file, with another field, or with two files', async () => {
      await auth(server().post('/media'), 'alice-token').expect(400);
      await upload(await photo(), { field: 'upload' }).expect(400);
      await auth(server().post('/media'), 'alice-token')
        .field('caption', 'x')
        .attach('file', await photo(), 'a.jpg')
        .expect(400);
      await auth(server().post('/media'), 'alice-token')
        .attach('file', await photo(), 'a.jpg')
        .attach('file', await photo(), 'b.jpg')
        .expect(400);
      expect(media).toEqual([]);
    });

    it('caps unattached uploads per account', async () => {
      await uploaded();
      await uploaded();
      await upload(await photo()).expect(409);
      // Another account has its own allowance.
      await uploaded('bob-token');
      expect(media).toHaveLength(3);
    });
  });

  describe('GET /media/:id and /file', () => {
    it('shows a pending upload to its uploader only', async () => {
      const { id } = await uploaded();
      await get(`/media/${id}`, 'alice-token').expect(200);
      await get(`/media/${id}`).expect(404);
      await get(`/media/${id}`, 'bob-token').expect(404);
      await get(`/media/${id}/file`, 'bob-token').expect(404);

      const file = await get(`/media/${id}/file`, 'alice-token').expect(200);
      expect(file.headers['content-type']).toBe('image/jpeg');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-security-policy']).toContain('sandbox');
      expect(Buffer.from(file.body as Buffer)).toEqual(
        [...objects.values()][0],
      );
    });

    it('answers 404 for an unknown id and 400 for a malformed one', async () => {
      await get('/media/no-such-media', 'alice-token').expect(404);
      await get('/media/bad.id').expect(400);
    });
  });

  describe('media posts', () => {
    const create = (body: object, token = 'alice-token') =>
      auth(server().post('/posts'), token).send({
        title: 'Look',
        community_id: 'c-garden',
        ...body,
      });

    it('attaches an upload, which then shows to everyone with the post', async () => {
      const { id } = await uploaded();
      const body: unknown = (
        await create({
          type: 'media',
          media_id: id,
          content: 'My tomatoes',
        }).expect(201)
      ).body;
      expect(body).toMatchObject({
        type: 'media',
        content: 'My tomatoes',
        media: {
          id,
          kind: 'image',
          width: 40,
          height: 20,
          url: `/media/${id}/file`,
        },
      });
      await get(`/media/${id}`).expect(200);
      await get(`/media/${id}/file`).expect(200);
      const post = await get(`/posts/${(body as { id: string }).id}`).expect(
        200,
      );
      expect(post.body).toMatchObject({ media: { id } });
    });

    it('takes a media post without a caption', async () => {
      const { id } = await uploaded();
      const body: unknown = (
        await create({ type: 'media', media_id: id }).expect(201)
      ).body;
      expect(body).toMatchObject({ content: null, media: { id } });
    });

    it.each([
      ['a media post without media_id', { type: 'media', content: 'x' }],
      [
        'a media post with only a URL',
        { type: 'media', content: 'https://example.com/a.png' },
      ],
      [
        'a text post with media_id',
        { type: 'text', content: 'x', media_id: 'some-id' },
      ],
      [
        'a link post with media_id',
        { type: 'link', content: 'https://example.com', media_id: 'some-id' },
      ],
    ])('refuses %s with 400', async (_name, body) => {
      await create(body).expect(400);
      expect(posts).toEqual([]);
    });

    it("refuses someone else's upload as unknown, and a second post for the same file", async () => {
      const { id } = await uploaded('bob-token');
      await create({ type: 'media', media_id: id }).expect(404);
      await create({ type: 'media', media_id: 'no-such-media' }).expect(404);

      const own = await uploaded();
      await create({ type: 'media', media_id: own.id }).expect(201);
      await create({ type: 'media', media_id: own.id }).expect(409);
      expect(posts).toHaveLength(1);
    });

    it('releases the file with its post, and the sweep deletes it', async () => {
      const { id } = await uploaded();
      const body: unknown = (
        await create({ type: 'media', media_id: id }).expect(201)
      ).body;
      // Attached: not deletable on its own.
      await auth(server().delete(`/media/${id}`), 'alice-token').expect(409);

      await auth(
        server().delete(`/posts/${(body as { id: string }).id}`),
        'alice-token',
      ).expect(204);
      await get(`/media/${id}`, 'alice-token').expect(404);
      expect(await sweep()).toMatchObject({ failed: 0 });
      expect(media).toEqual([]);
      expect(objects.size).toBe(0);
    });
  });

  describe('DELETE /media/:id', () => {
    it("releases the uploader's own pending upload, and is 404 to anyone else", async () => {
      const { id } = await uploaded();
      await auth(server().delete(`/media/${id}`), 'bob-token').expect(404);
      await auth(server().delete(`/media/${id}`), 'alice-token').expect(204);
      await get(`/media/${id}`, 'alice-token').expect(404);
      await auth(server().delete(`/media/${id}`), 'alice-token').expect(404);
      await sweep();
      expect(objects.size).toBe(0);
    });

    it('refuses a profile image, which has its own route', async () => {
      const avatar = await upload(await photo(), {
        method: 'put',
        path: '/users/me/avatar',
      }).expect(200);
      await auth(
        server().delete(`/media/${(avatar.body as { id: string }).id}`),
        'alice-token',
      ).expect(409);
    });
  });

  describe('avatars', () => {
    it('normalises, shows on the profile, replaces and removes', async () => {
      const first = await upload(await photo(), {
        method: 'put',
        path: '/users/me/avatar',
      }).expect(200);
      expect(first.body).toMatchObject({
        kind: 'image',
        mime_type: 'image/webp',
        width: 256,
        height: 256,
      });
      const firstId = (first.body as { id: string }).id;
      const profile = await get('/users/alice').expect(200);
      expect(profile.body).toMatchObject({
        avatar: { id: firstId, width: 256 },
      });
      // Public while it is the avatar.
      await get(`/media/${firstId}/file`).expect(200);

      const second = await upload(await photo(), {
        method: 'put',
        path: '/users/me/avatar',
      }).expect(200);
      await get(`/media/${firstId}`, 'alice-token').expect(404);
      await sweep();
      expect(media.map((row) => row.id)).toEqual([
        (second.body as { id: string }).id,
      ]);

      await auth(server().delete('/users/me/avatar'), 'alice-token').expect(
        204,
      );
      expect((await get('/users/alice').expect(200)).body).toMatchObject({
        avatar: null,
      });
      await auth(server().delete('/users/me/avatar'), 'alice-token').expect(
        204,
      );
      await sweep();
      expect(objects.size).toBe(0);
    });

    it('refuses a video, and anything without a token', async () => {
      const mp4 = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from('ftypmp42'),
        Buffer.alloc(16),
      ]);
      await upload(mp4, {
        method: 'put',
        path: '/users/me/avatar',
        contentType: 'video/mp4',
      }).expect(415);
      await upload(await photo(), {
        method: 'put',
        path: '/users/me/avatar',
        token: null,
      }).expect(401);
      await auth(server().delete('/users/me/avatar'), null).expect(401);
      expect(objects.size).toBe(0);
    });
  });

  describe('community icons and banners', () => {
    it.each([
      ['icon', 256, 256],
      ['banner', 1536, 384],
    ] as const)(
      'lets the creator set and remove the %s, %dx%d, logged',
      async (slot, width, height) => {
        const body: unknown = (
          await upload(await photo(), {
            method: 'put',
            path: `/communities/garden/${slot}`,
          }).expect(200)
        ).body;
        expect(body).toMatchObject({ mime_type: 'image/webp', width, height });
        const detail = await get('/communities/garden').expect(200);
        expect(detail.body).toMatchObject({
          [slot]: { id: (body as { id: string }).id },
        });
        expect(logged).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: 'community_updated',
            metadata: { fields: slot },
          }),
        );

        await auth(
          server().delete(`/communities/garden/${slot}`),
          'alice-token',
        ).expect(204);
        expect(
          (await get('/communities/garden').expect(200)).body,
        ).toMatchObject({ [slot]: null });
        await sweep();
        expect(objects.size).toBe(0);
      },
    );

    it('refuses anyone but the creator before processing the file', async () => {
      await upload(await photo(), {
        method: 'put',
        path: '/communities/garden/icon',
        token: 'bob-token',
      }).expect(403);
      await upload(await photo(), {
        method: 'put',
        path: '/communities/nowhere/icon',
      }).expect(404);
      await auth(
        server().delete('/communities/garden/banner'),
        'bob-token',
      ).expect(403);
      expect(objects.size).toBe(0);
      expect(media).toEqual([]);
    });
  });

  describe('the sweep', () => {
    it('releases uploads never attached within the pending window', async () => {
      const { id } = await uploaded();
      const fresh = await uploaded();
      media.find((row) => row.id === id)!.created_at = new Date(
        Date.now() - 25 * 3600_000,
      );
      expect(await sweep()).toEqual({ released: 1, deleted: 1, failed: 0 });
      expect(media.map((row) => row.id)).toEqual([fresh.id]);
      expect(objects.size).toBe(1);
    });
  });
});
