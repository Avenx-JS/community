import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createConnection,
  createPool,
  type Connection,
  type Pool,
  type RowDataPacket,
} from 'mysql2/promise';
import sharp from 'sharp';
import { CommunitiesService } from '../communities/communities.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { MediaCleanupService } from '../media/media-cleanup.service';
import { readMediaConfig, type MediaConfig } from '../media/media.config';
import {
  RELEASE_ACCOUNT_MEDIA_SQL,
  VISIBLE_MEDIA_SQL,
} from '../media/media-sql';
import { MediaService } from '../media/media.service';
import { LocalMediaStorage } from '../media/storage/local-media-storage';
import { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from '../posts/posts.service';
import { UsersService } from '../users/users.service';
import {
  loadMigrations,
  runMigrations,
  type MigrationConnection,
} from './migrate';
import { runSqlScript } from './sql-script';

const migrations = resolve(__dirname, '../../../../data/migrations');
const VERSION = '035_create_media';

const snapshot = readFileSync(
  resolve(__dirname, '../../../../data/community.sql'),
  'utf8',
).replace(/^CREATE DATABASE[^;]*;\s*USE community;/, '');

// The snapshot with 035 undone: its appended block and the version.
const preceding = snapshot
  .replace(
    /-- Uploaded media and profile images \(035_create_media\)\.\r?\n[\s\S]*?(?=-- [^\n]*\(\d{3}_[a-z_]+\)\.\r?\n|CREATE TABLE schema_migrations)/,
    '',
  )
  .replace(/,\r?\n\s*\('035_create_media'\)/, '');

// Migration 035 through the real runner over a database at 034, then the
// whole lifecycle on a real server with files in a scratch directory:
// uploads, a media post, avatars, community images, every release path and
// the sweep. Opt in with MYSQL_INTEGRATION_TEST=true and MYSQL_* credentials
// that may create and drop scratch databases; skipped otherwise.
const integration =
  process.env.MYSQL_INTEGRATION_TEST === 'true' ? describe : describe.skip;

integration('media (MySQL)', () => {
  const database = `media_${randomBytes(4).toString('hex')}`;
  const fresh = `${database}_fresh`;
  const credentials = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  const accepting = {
    assertAcceptedOrThrow: () => Promise.resolve(),
  } as unknown as CommunityRuleAcceptanceService;
  let connection: Connection;
  let pool: Pool;
  let directory: string;
  let config: MediaConfig;
  let media: MediaService;
  let cleanup: MediaCleanupService;
  let posts: PostsService;
  let communities: CommunitiesService;
  let users: UsersService;
  let firstRun: string[];
  let secondRun: string[];

  const rows = async (sql: string, values: unknown[] = []) =>
    (await connection.query<RowDataPacket[]>(sql, values))[0];
  const migrate = async () => {
    const runner: MigrationConnection = {
      execute: async (sql, values) => {
        const [result, fields] = await connection.execute(sql, values);
        return [result, fields];
      },
      query: async (sql) => {
        const [result, fields] = await connection.query(sql);
        return [result, fields];
      },
      end: () => Promise.resolve(),
    };
    const log: string[] = [];
    await runMigrations(runner, await loadMigrations(migrations), (line) =>
      log.push(line),
    );
    return log.filter((line) => !line.startsWith('Skipped'));
  };
  const TABLES = "('media', 'posts', 'users', 'communities')";
  const schema = async (name: string) => ({
    columns: await rows(
      `SELECT table_name AS t, column_name AS name, column_type AS type,
              is_nullable AS nullable, column_default AS def
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name IN ${TABLES}
       ORDER BY table_name, column_name`,
      [name],
    ),
    indexes: await rows(
      `SELECT table_name AS t, index_name AS name, non_unique AS nonUnique,
              GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name IN ${TABLES}
       GROUP BY table_name, index_name, non_unique ORDER BY table_name, index_name`,
      [name],
    ),
    foreignKeys: await rows(
      `SELECT k.table_name AS t, k.constraint_name AS name, k.column_name AS col,
              k.referenced_table_name AS target, r.delete_rule AS onDelete
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
       WHERE k.table_schema = ? AND k.table_name IN ${TABLES}
       ORDER BY k.table_name, k.constraint_name`,
      [name],
    ),
  });
  const photo = () =>
    sharp({
      create: { width: 30, height: 20, channels: 3, background: '#4a7' },
    })
      .withExif({ IFD0: { Model: 'Secret Phone 9' } })
      .jpeg()
      .toBuffer();
  const file = async () => {
    const buffer = await photo();
    return { buffer, size: buffer.length };
  };
  const files = async () => {
    const shards = await readdir(directory).catch(() => [] as string[]);
    const all = await Promise.all(
      shards.map(async (shard) =>
        (await readdir(join(directory, shard))).map(
          (name) => `${shard}/${name}`,
        ),
      ),
    );
    return all.flat().sort();
  };
  const mediaRow = async (id: string) =>
    (await rows('SELECT * FROM media WHERE id = ?', [id]))[0];

  beforeAll(async () => {
    expect(preceding).not.toMatch(
      /CREATE TABLE media|avatar_media_id|icon_media_id/,
    );
    expect(preceding).not.toContain(VERSION);

    connection = await createConnection({
      ...credentials,
      multipleStatements: true,
    });
    await runSqlScript(
      connection,
      `CREATE DATABASE ${fresh}; USE ${fresh}; ${snapshot}`,
    );
    await runSqlScript(
      connection,
      `CREATE DATABASE ${database}; USE ${database}; ${preceding}`,
    );
    await connection.query(`
      INSERT INTO users (id, username, email, password_hash) VALUES
        ('alice', 'alice', 'alice@example.test', 'x'),
        ('bob', 'bob', 'bob@example.test', 'x');
      INSERT INTO communities (id, creator_id, name) VALUES ('c-garden', 'alice', 'garden');
      INSERT INTO posts (id, title, content, type, author_id, community_id)
        VALUES ('p-legacy', 'Old', 'https://example.com/a.png', 'media', 'alice', 'c-garden');`);

    firstRun = await migrate();
    secondRun = await migrate();

    directory = await mkdtemp(join(tmpdir(), 'media-mysql-'));
    config = {
      ...readMediaConfig({}),
      localDirectory: directory,
      sweepIntervalSeconds: 0,
    };
    pool = createPool({ ...credentials, database, connectionLimit: 6 });
    const storage = new LocalMediaStorage(directory);
    const log = new CommunityModerationLogService(pool);
    cleanup = new MediaCleanupService(pool, storage, config);
    jest.spyOn(cleanup, 'requestSweep').mockImplementation(() => undefined);
    media = new MediaService(pool, storage, config, cleanup, log);
    posts = new PostsService(
      pool,
      new NotificationsService(pool),
      accepting,
      log,
    );
    communities = new CommunitiesService(pool, accepting, log);
    users = new UsersService(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await connection?.query(`DROP DATABASE IF EXISTS ${database}`);
    await connection?.query(`DROP DATABASE IF EXISTS ${fresh}`);
    await connection?.end();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe('migration 035', () => {
    it('applies once, and skips on a second run', () => {
      expect(firstRun.join('\n')).toContain(VERSION);
      expect(secondRun.join('\n')).not.toContain(VERSION);
    });

    it('leaves the four tables exactly as a fresh installation has them', async () => {
      expect(await schema(database)).toEqual(await schema(fresh));
    });

    it('changes no existing row: a legacy media post keeps its URL and has no file', async () => {
      expect(
        (
          await rows(
            "SELECT content, media_id FROM posts WHERE id = 'p-legacy'",
          )
        )[0],
      ).toEqual({
        content: 'https://example.com/a.png',
        media_id: null,
      });
    });
  });

  describe('the lifecycle', () => {
    it('stores an upload without EXIF, private to its uploader until posted', async () => {
      const upload = await media.upload(await file(), 'alice');
      const row = await mediaRow(upload.id);
      expect(row).toMatchObject({
        uploader_id: 'alice',
        purpose: 'post',
        kind: 'image',
        width: 30,
        height: 20,
        released_at: null,
      });
      const bytes = await readFile(join(directory, String(row.storage_key)));
      expect(bytes.includes(Buffer.from('Secret Phone'))).toBe(false);

      expect(
        await rows(VISIBLE_MEDIA_SQL, [upload.id, 'alice', 'alice']),
      ).toHaveLength(1);
      expect(
        await rows(VISIBLE_MEDIA_SQL, [upload.id, null, null]),
      ).toHaveLength(0);
      expect(
        await rows(VISIBLE_MEDIA_SQL, [upload.id, 'bob', 'bob']),
      ).toHaveLength(0);
    });

    it('attaches to one post only, enforced by the schema too', async () => {
      const upload = await media.upload(await file(), 'alice');
      const post = await posts.create(
        {
          title: 'Tomatoes',
          type: 'media',
          media_id: upload.id,
          community_id: 'c-garden',
        } as never,
        'alice',
      );
      expect(post.media).toMatchObject({ id: upload.id });
      expect(
        await rows(VISIBLE_MEDIA_SQL, [upload.id, null, null]),
      ).toHaveLength(1);
      await expect(
        connection.query(
          "INSERT INTO posts (id, title, type, author_id, community_id, media_id) VALUES ('p-dup', 'Dup', 'media', 'alice', 'c-garden', ?)",
          [upload.id],
        ),
      ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      // RESTRICT: a file in use cannot be deleted under its post.
      await expect(
        connection.query('DELETE FROM media WHERE id = ?', [upload.id]),
      ).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });

      await posts.remove(post.id, 'alice');
      expect((await mediaRow(upload.id)).released_at).not.toBeNull();
      const key = String((await mediaRow(upload.id)).storage_key);
      await cleanup.sweep();
      expect(await mediaRow(upload.id)).toBeUndefined();
      expect(await files()).not.toContain(key);
    });

    it('replaces an avatar, releasing the old one, and shows it on the profile', async () => {
      const first = await media.setAvatar(await file(), 'bob');
      expect(first).toMatchObject({
        mime_type: 'image/webp',
        width: 256,
        height: 256,
      });
      const second = await media.setAvatar(await file(), 'bob');
      expect((await mediaRow(first.id)).released_at).not.toBeNull();
      expect(await users.getUserProfile('bob')).toMatchObject({
        avatar: { id: second.id },
      });
      await cleanup.sweep();
      expect(await mediaRow(first.id)).toBeUndefined();
      expect(await mediaRow(second.id)).toBeDefined();
    });

    it("releases a deleted account's avatar and unposted uploads, keeping its posts' files", async () => {
      const avatar = await media.setAvatar(await file(), 'alice');
      const pending = await media.upload(await file(), 'alice');
      const posted = await media.upload(await file(), 'alice');
      await posts.create(
        {
          title: 'Kept',
          type: 'media',
          media_id: posted.id,
          community_id: 'c-garden',
        } as never,
        'alice',
      );
      for (const sql of RELEASE_ACCOUNT_MEDIA_SQL) {
        await connection.query(sql, ['alice']);
      }
      expect(
        (await rows("SELECT avatar_media_id FROM users WHERE id = 'alice'"))[0]
          .avatar_media_id,
      ).toBeNull();
      expect((await mediaRow(avatar.id)).released_at).not.toBeNull();
      expect((await mediaRow(pending.id)).released_at).not.toBeNull();
      expect((await mediaRow(posted.id)).released_at).toBeNull();
      await cleanup.sweep();
      expect(await mediaRow(avatar.id)).toBeUndefined();
      expect(await mediaRow(pending.id)).toBeUndefined();
      expect(await mediaRow(posted.id)).toBeDefined();
    });

    it("releases a deleted community's icon and banner", async () => {
      await connection.query(
        "INSERT INTO communities (id, creator_id, name) VALUES ('c-gone', 'bob', 'gone')",
      );
      const icon = await media.setCommunityImage(
        'gone',
        'icon',
        await file(),
        'bob',
      );
      const banner = await media.setCommunityImage(
        'gone',
        'banner',
        await file(),
        'bob',
      );
      expect(banner).toMatchObject({ width: 1536, height: 384 });
      expect(await communities.findOne('gone')).toMatchObject({
        icon: { id: icon.id },
        banner: { id: banner.id },
      });
      const logged = await rows(
        "SELECT metadata FROM community_moderation_actions WHERE community_id = 'c-gone' AND action = 'community_updated' ORDER BY created_at",
      );
      expect(logged).toHaveLength(2);

      await communities.remove('gone', 'gone', 'bob');
      expect(
        (
          await rows(
            "SELECT icon_media_id, banner_media_id FROM communities WHERE id = 'c-gone'",
          )
        )[0],
      ).toEqual({
        icon_media_id: null,
        banner_media_id: null,
      });
      await cleanup.sweep();
      expect(await mediaRow(icon.id)).toBeUndefined();
      expect(await mediaRow(banner.id)).toBeUndefined();
    });

    it('releases an upload never posted once the pending window has passed', async () => {
      const stale = await media.upload(await file(), 'bob');
      const fresh = await media.upload(await file(), 'bob');
      await connection.query(
        'UPDATE media SET created_at = CURRENT_TIMESTAMP - INTERVAL ? HOUR WHERE id = ?',
        [config.pendingTtlHours + 1, stale.id],
      );
      const result = await cleanup.sweep();
      expect(result.released).toBe(1);
      expect(await mediaRow(stale.id)).toBeUndefined();
      expect(await mediaRow(fresh.id)).toBeDefined();
    });

    it('never deletes a file still referenced, even if marked released', async () => {
      const upload = await media.upload(await file(), 'bob');
      await posts.create(
        {
          title: 'In use',
          type: 'media',
          media_id: upload.id,
          community_id: 'c-garden',
        } as never,
        'bob',
      );
      await connection.query(
        'UPDATE media SET released_at = UTC_TIMESTAMP() WHERE id = ?',
        [upload.id],
      );
      await cleanup.sweep();
      expect(await mediaRow(upload.id)).toBeDefined();
      expect(await files()).toContain(
        String((await mediaRow(upload.id)).storage_key),
      );
    });

    it('serves the sweep from idx_media_released', async () => {
      const [plan] = await rows(
        'EXPLAIN SELECT id FROM media WHERE released_at IS NOT NULL ORDER BY released_at, id LIMIT 100',
      );
      expect(plan.key).toBe('idx_media_released');
    });
  });
});
