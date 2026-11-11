import { describe, expect, it, jest } from '@jest/globals';
import {
  ConflictException,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import sharp from 'sharp';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { MediaCleanupService } from './media-cleanup.service';
import { readMediaConfig, type MediaConfig } from './media.config';
import {
  DELETE_RELEASED_MEDIA_SQL,
  INSERT_MEDIA_SQL,
  LOCK_UPLOADER_SQL,
  PENDING_UPLOADS_SQL,
  RELEASED_MEDIA_SQL,
  RELEASE_STALE_UPLOADS_SQL,
} from './media-sql';
import { MediaService } from './media.service';
import type { MediaStorage } from './storage/media-storage';

const config: MediaConfig = {
  ...readMediaConfig({}),
  pendingMax: 2,
  sweepIntervalSeconds: 0,
};

function harness(answers: Record<string, unknown> = {}) {
  const log: string[] = [];
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const execute = (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql in answers) {
      const answer = answers[sql];
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve([answer, []]);
    }
    if (sql === LOCK_UPLOADER_SQL) {
      return Promise.resolve([[{ id: 'u-1' }], []]);
    }
    if (sql === PENDING_UPLOADS_SQL) {
      return Promise.resolve([[{ pending: 0 }], []]);
    }
    return Promise.resolve([{ affectedRows: 1 }, []]);
  };
  const connection = {
    execute,
    beginTransaction: () => {
      log.push('begin');
      return Promise.resolve();
    },
    commit: () => {
      log.push('commit');
      return Promise.resolve();
    },
    rollback: () => {
      log.push('rollback');
      return Promise.resolve();
    },
    release: () => log.push('release'),
  };
  const pool = {
    execute,
    getConnection: () => Promise.resolve(connection),
  } as unknown as Pool;
  const objects = new Map<string, Buffer>();
  const put = jest.fn((key: string, body: Buffer) => {
    log.push('put');
    objects.set(key, body);
    return Promise.resolve();
  });
  const remove = jest.fn((key: string) => {
    log.push('delete');
    objects.delete(key);
    return Promise.resolve();
  });
  const storage: MediaStorage = {
    put,
    get: (key: string) => Promise.resolve(objects.get(key) ?? null),
    delete: remove,
  };
  const cleanup = new MediaCleanupService(pool, storage, config);
  jest.spyOn(cleanup, 'requestSweep').mockImplementation(() => undefined);
  const service = new MediaService(pool, storage, config, cleanup, {
    record: jest.fn(() => Promise.resolve()),
  } as unknown as CommunityModerationLogService);
  return { service, cleanup, put, remove, objects, statements, log };
}

const png = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
    .png()
    .toBuffer();
const file = (buffer: Buffer) => ({ buffer, size: buffer.length });

describe('MediaService.upload', () => {
  it('writes the object, then the row under the uploader lock, then commits', async () => {
    const { service, statements, log } = harness();
    const dto = await service.upload(file(await png()), 'u-1');
    expect(log).toEqual(['put', 'begin', 'commit', 'release']);
    const inserted = statements.find(({ sql }) => sql === INSERT_MEDIA_SQL);
    expect(inserted?.values).toEqual([
      dto.id,
      'u-1',
      'post',
      'image',
      'image/png',
      dto.size_bytes,
      4,
      4,
      `${dto.id.slice(0, 2)}/${dto.id}.png`,
    ]);
    // The cap is counted again under the lock, before the insert.
    const order = statements.map(({ sql }) => sql);
    expect(order.indexOf(LOCK_UPLOADER_SQL)).toBeLessThan(
      order.lastIndexOf(PENDING_UPLOADS_SQL),
    );
    expect(order.lastIndexOf(PENDING_UPLOADS_SQL)).toBeLessThan(
      order.indexOf(INSERT_MEDIA_SQL),
    );
  });

  it('deletes the object when the row cannot be written, so neither half remains', async () => {
    const { service, objects, log } = harness({
      [INSERT_MEDIA_SQL]: new Error('insert failed'),
    });
    await expect(service.upload(file(await png()), 'u-1')).rejects.toThrow(
      'insert failed',
    );
    expect(log).toEqual(['put', 'begin', 'rollback', 'release', 'delete']);
    expect(objects.size).toBe(0);
  });

  it('refuses at the cap before any work, and again under the lock', async () => {
    const atCap = harness({ [PENDING_UPLOADS_SQL]: [{ pending: 2 }] });
    await expect(
      atCap.service.upload(file(await png()), 'u-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(atCap.put).not.toHaveBeenCalled();
  });

  it('refuses an upload for a deleted account, deleting the object', async () => {
    const { service, objects } = harness({ [LOCK_UPLOADER_SQL]: [] });
    await expect(
      service.upload(file(await png()), 'u-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(objects.size).toBe(0);
  });

  it('refuses a disallowed type even when it is otherwise supported', async () => {
    const { service } = harness();
    const narrowed = new MediaService(
      {} as Pool,
      {} as MediaStorage,
      { ...config, allowedTypes: ['image/webp'] },
      {} as MediaCleanupService,
      {} as CommunityModerationLogService,
    );
    await expect(
      narrowed.upload(file(await png()), 'u-1'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(
      service.upload(file(await png()), 'u-1'),
    ).resolves.toBeDefined();
  });
});

describe('MediaCleanupService.sweep', () => {
  it('releases stale uploads, then deletes each released object before its row', async () => {
    const { cleanup, remove, statements, log } = harness({
      [RELEASE_STALE_UPLOADS_SQL]: { affectedRows: 1 },
      [RELEASED_MEDIA_SQL]: [
        { id: 'm-1', storage_key: 'ab/m-1.png' },
        { id: 'm-2', storage_key: 'cd/m-2.png' },
      ],
    });
    expect(await cleanup.sweep(50)).toEqual({
      released: 1,
      deleted: 2,
      failed: 0,
    });
    expect(statements[0]).toEqual({
      sql: RELEASE_STALE_UPLOADS_SQL,
      values: [config.pendingTtlHours],
    });
    expect(statements[1]).toEqual({ sql: RELEASED_MEDIA_SQL, values: [50] });
    expect(remove).toHaveBeenCalledWith('ab/m-1.png');
    expect(
      statements.filter(({ sql }) => sql === DELETE_RELEASED_MEDIA_SQL),
    ).toEqual([
      { sql: DELETE_RELEASED_MEDIA_SQL, values: ['m-1'] },
      { sql: DELETE_RELEASED_MEDIA_SQL, values: ['m-2'] },
    ]);
    expect(log).toEqual(['delete', 'delete']);
  });

  // A storage failure keeps the row, so the next run retries the object.
  it('keeps the row of an object it could not delete, and carries on', async () => {
    const { cleanup, remove, statements } = harness({
      [RELEASE_STALE_UPLOADS_SQL]: { affectedRows: 0 },
      [RELEASED_MEDIA_SQL]: [
        { id: 'm-1', storage_key: 'ab/m-1.png' },
        { id: 'm-2', storage_key: 'cd/m-2.png' },
      ],
    });
    remove.mockImplementationOnce(() =>
      Promise.reject(new Error('storage down')),
    );
    expect(await cleanup.sweep()).toEqual({
      released: 0,
      deleted: 1,
      failed: 1,
    });
    expect(
      statements
        .filter(({ sql }) => sql === DELETE_RELEASED_MEDIA_SQL)
        .map(({ values }) => values[0]),
    ).toEqual(['m-2']);
  });

  it('runs one sweep at a time, joining a request during a run', async () => {
    const { cleanup } = harness({
      [RELEASE_STALE_UPLOADS_SQL]: { affectedRows: 0 },
      [RELEASED_MEDIA_SQL]: [],
    });
    const first = cleanup.sweep();
    expect(cleanup.sweep()).toBe(first);
    await first;
    expect(cleanup.sweep()).not.toBe(first);
  });

  it('starts no timer when the interval is 0', () => {
    const spy = jest.spyOn(global, 'setInterval');
    harness().cleanup.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('guards every delete against a file still in use', () => {
    for (const sql of [
      RELEASED_MEDIA_SQL,
      DELETE_RELEASED_MEDIA_SQL,
      RELEASE_STALE_UPLOADS_SQL,
    ]) {
      expect(sql).toContain('posts.media_id = media.id');
      expect(sql).toContain('users.avatar_media_id = media.id');
      expect(sql).toContain('communities.icon_media_id = media.id');
      expect(sql).toContain('communities.banner_media_id = media.id');
    }
  });
});
