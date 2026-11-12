import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { isSqlTrue } from '../common/community-moderation';
import { COMMUNITY_VISIBLE_PREDICATE } from '../common/community-visibility';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { MediaCleanupService } from './media-cleanup.service';
import { MEDIA_CONFIG, type MediaConfig } from './media.config';
import { toMediaDto, type MediaDto, type MediaRow } from './media-dto';
import {
  normaliseProfileImage,
  processPostMedia,
  UndecodableMediaError,
  type ProcessedMedia,
  type ProfileImagePurpose,
} from './media-processing';
import {
  INSERT_MEDIA_SQL,
  LOCK_OWN_UPLOAD_SQL,
  LOCK_UPLOADER_SQL,
  PENDING_UPLOADS_SQL,
  RELEASE_MEDIA_SQL,
  VISIBLE_MEDIA_SQL,
} from './media-sql';
import {
  EXTENSIONS,
  kindOf,
  sniffMediaType,
  type MediaMimeType,
} from './media-sniff';
import {
  MEDIA_STORAGE,
  storageKey,
  type MediaStorage,
} from './storage/media-storage';

export interface UploadedFile {
  buffer: Buffer;
  size: number;
}

export type CommunityImageSlot = 'icon' | 'banner';
const SLOT_COLUMN = {
  icon: 'icon_media_id',
  banner: 'banner_media_id',
} as const;
const SLOT_PURPOSE: Record<CommunityImageSlot, ProfileImagePurpose> = {
  icon: 'community_icon',
  banner: 'community_banner',
};

export const MEDIA_NOT_FOUND = 'Media not found';

type Executor = Pick<Pool | PoolConnection, 'execute'>;

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
    private readonly cleanup: MediaCleanupService,
    private readonly moderationLog: CommunityModerationLogService,
  ) {}

  // POST /media: an image or video for a post. It stays the uploader's,
  // pending, until POST /posts attaches it (or the sweep releases it).
  async upload(file: UploadedFile | undefined, uploaderId: string) {
    const type = this.acceptedType(file);
    // Fail fast before the work; the count is repeated under the lock.
    await this.assertBelowPendingCap(this.pool, uploaderId);
    const processed = await this.decode(() =>
      processPostMedia(file!.buffer, type, this.config.maxPixels),
    );
    return this.store(processed, 'post', uploaderId, async (connection) => {
      const [users] = await connection.execute<RowDataPacket[]>(
        LOCK_UPLOADER_SQL,
        [uploaderId],
      );
      if (!users[0]) {
        throw new NotFoundException('User not found');
      }
      await this.assertBelowPendingCap(connection, uploaderId);
    });
  }

  // GET /media/:id: only while the content it belongs to is visible, or to
  // its uploader (see VISIBLE_MEDIA_SQL).
  async findVisible(id: string, viewerId?: string): Promise<MediaDto> {
    return toMediaDto(await this.visibleRow(id, viewerId), this.config);
  }

  // GET /media/:id/file: the same rule, then the bytes.
  async readFile(
    id: string,
    viewerId?: string,
  ): Promise<{ body: Buffer; mimeType: MediaMimeType }> {
    const row = await this.visibleRow(id, viewerId);
    const body = await this.storage.get(row.storage_key);
    if (!body) {
      throw new NotFoundException(MEDIA_NOT_FOUND);
    }
    return { body, mimeType: row.mime_type };
  }

  // DELETE /media/:id: the uploader's own upload, while no post uses it.
  // Another account's file is 404, never 403: an id says nothing about who
  // holds it. A profile image is removed through its own route.
  async deleteUpload(id: string, userId: string): Promise<void> {
    await this.inTransaction(async (connection) => {
      const [rows] = await connection.execute<
        (RowDataPacket & {
          uploader_id: string | null;
          purpose: string;
          released_at: Date | string | null;
          attached: number | string | boolean;
        })[]
      >(LOCK_OWN_UPLOAD_SQL, [id]);
      const row = rows[0];
      if (!row || row.uploader_id !== userId || row.released_at) {
        throw new NotFoundException(MEDIA_NOT_FOUND);
      }
      if (row.purpose !== 'post') {
        throw new ConflictException(
          'This file is a profile image; remove it through its avatar, icon or banner route',
        );
      }
      if (isSqlTrue(row.attached)) {
        throw new ConflictException(
          'This file is attached to a post; delete the post to release it',
        );
      }
      await connection.execute<ResultSetHeader>(RELEASE_MEDIA_SQL, [id]);
    });
    this.cleanup.requestSweep();
  }

  // PUT /users/me/avatar: normalised, then swapped in; the previous avatar
  // is released in the same transaction.
  async setAvatar(file: UploadedFile | undefined, userId: string) {
    const processed = await this.profileImage(file, 'avatar');
    const dto = await this.store(
      processed,
      'avatar',
      userId,
      async (connection, mediaId) => {
        const [users] = await connection.execute<
          (RowDataPacket & { avatar_media_id: string | null })[]
        >(
          'SELECT avatar_media_id FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
          [userId],
        );
        if (!users[0]) {
          throw new NotFoundException('User not found');
        }
        return async () => {
          await connection.execute<ResultSetHeader>(
            'UPDATE users SET avatar_media_id = ? WHERE id = ?',
            [mediaId, userId],
          );
          await this.release(connection, users[0].avatar_media_id);
        };
      },
    );
    this.cleanup.requestSweep();
    return dto;
  }

  // DELETE /users/me/avatar. Idempotent: without an avatar, nothing changes.
  async clearAvatar(userId: string): Promise<void> {
    await this.inTransaction(async (connection) => {
      const [users] = await connection.execute<
        (RowDataPacket & { avatar_media_id: string | null })[]
      >('SELECT avatar_media_id FROM users WHERE id = ? LIMIT 1 FOR UPDATE', [
        userId,
      ]);
      await connection.execute<ResultSetHeader>(
        'UPDATE users SET avatar_media_id = NULL WHERE id = ?',
        [userId],
      );
      await this.release(connection, users[0]?.avatar_media_id ?? null);
    });
    this.cleanup.requestSweep();
  }

  // PUT /communities/:name/icon and /banner: the creator only, as for every
  // other edit of the community (PATCH /communities/:name). Recorded in the
  // community's moderation log as community_updated, naming the field.
  async setCommunityImage(
    name: string,
    slot: CommunityImageSlot,
    file: UploadedFile | undefined,
    actorId: string,
  ) {
    // Authorised before the file is processed: a stranger's upload must not
    // cost the server an image decode.
    await this.lockCommunity(this.pool, name, actorId, false);
    const processed = await this.profileImage(file, SLOT_PURPOSE[slot]);
    const dto = await this.store(
      processed,
      SLOT_PURPOSE[slot],
      actorId,
      async (connection, mediaId) => {
        const community = await this.lockCommunity(
          connection,
          name,
          actorId,
          true,
        );
        return async () => {
          await connection.execute<ResultSetHeader>(
            `UPDATE communities SET ${SLOT_COLUMN[slot]} = ? WHERE id = ?`,
            [mediaId, community.id],
          );
          await this.release(connection, community[SLOT_COLUMN[slot]]);
          await this.recordCommunityUpdate(
            connection,
            community.id,
            slot,
            actorId,
          );
        };
      },
    );
    this.cleanup.requestSweep();
    return dto;
  }

  // DELETE /communities/:name/icon and /banner. Idempotent, and logged only
  // when something was removed.
  async clearCommunityImage(
    name: string,
    slot: CommunityImageSlot,
    actorId: string,
  ): Promise<void> {
    await this.inTransaction(async (connection) => {
      const community = await this.lockCommunity(
        connection,
        name,
        actorId,
        true,
      );
      const current = community[SLOT_COLUMN[slot]];
      if (!current) {
        return;
      }
      await connection.execute<ResultSetHeader>(
        `UPDATE communities SET ${SLOT_COLUMN[slot]} = NULL WHERE id = ?`,
        [community.id],
      );
      await this.release(connection, current);
      await this.recordCommunityUpdate(connection, community.id, slot, actorId);
    });
    this.cleanup.requestSweep();
  }

  // The checks every upload shares: present, within size, and of an allowed
  // type by its content. The client's Content-Type and filename are ignored.
  private acceptedType(file: UploadedFile | undefined): MediaMimeType {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('file is required');
    }
    // multer enforces the limit while reading; checked again here, so the
    // rule does not depend on how the bytes arrived.
    if (file.buffer.length > this.config.maxBytes) {
      throw new PayloadTooLargeException(
        `The file exceeds the maximum size of ${this.config.maxBytes} bytes`,
      );
    }
    const type = sniffMediaType(file.buffer);
    if (!type || !this.config.allowedTypes.includes(type)) {
      throw new UnsupportedMediaTypeException(
        `Unsupported file type; allowed are ${this.config.allowedTypes.join(', ')}`,
      );
    }
    return type;
  }

  private async profileImage(
    file: UploadedFile | undefined,
    purpose: ProfileImagePurpose,
  ): Promise<ProcessedMedia> {
    const type = this.acceptedType(file);
    if (kindOf(type) !== 'image') {
      throw new UnsupportedMediaTypeException(
        'Avatars, icons and banners must be images',
      );
    }
    return this.decode(() =>
      normaliseProfileImage(file!.buffer, purpose, this.config.maxPixels),
    );
  }

  private async decode(
    work: () => Promise<ProcessedMedia>,
  ): Promise<ProcessedMedia> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UndecodableMediaError) {
        throw new BadRequestException('The file could not be decoded');
      }
      throw error;
    }
  }

  // The object is written first, then the row in a transaction with the
  // caller's checks and changes. A failed transaction deletes the object, so
  // neither half outlives the other. `prepare` runs its checks under the
  // transaction's locks and may return the changes to apply after the
  // insert.
  private async store(
    processed: ProcessedMedia,
    purpose: MediaRow['purpose'],
    uploaderId: string,
    prepare: (
      connection: PoolConnection,
      mediaId: string,
    ) => Promise<void | (() => Promise<void>)>,
  ): Promise<MediaDto> {
    const id = randomUUID();
    const key = storageKey(id, EXTENSIONS[processed.mimeType]);
    await this.storage.put(key, processed.body, processed.mimeType);
    try {
      await this.inTransaction(async (connection) => {
        const apply = await prepare(connection, id);
        await connection.execute<ResultSetHeader>(INSERT_MEDIA_SQL, [
          id,
          uploaderId,
          purpose,
          kindOf(processed.mimeType),
          processed.mimeType,
          processed.body.length,
          processed.width,
          processed.height,
          key,
        ]);
        if (apply) {
          await apply();
        }
      });
    } catch (error) {
      await this.storage.delete(key).catch((cleanupError: unknown) => {
        this.logger.warn(
          `Could not delete the object of failed upload ${id}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      });
      throw error;
    }
    return toMediaDto(
      {
        id,
        uploader_id: uploaderId,
        purpose,
        kind: kindOf(processed.mimeType),
        mime_type: processed.mimeType,
        size_bytes: processed.body.length,
        width: processed.width,
        height: processed.height,
        storage_key: key,
        created_at: new Date(),
      } as MediaRow,
      this.config,
    );
  }

  private async assertBelowPendingCap(
    executor: Executor,
    uploaderId: string,
  ): Promise<void> {
    const [rows] = await executor.execute<
      (RowDataPacket & { pending: number | string })[]
    >(PENDING_UPLOADS_SQL, [uploaderId]);
    if (Number(rows[0]?.pending ?? 0) >= this.config.pendingMax) {
      throw new ConflictException(
        `You have ${this.config.pendingMax} uploads not yet attached to a post; post or delete one first`,
      );
    }
  }

  private async visibleRow(id: string, viewerId?: string): Promise<MediaRow> {
    const [rows] = await this.pool.execute<MediaRow[]>(VISIBLE_MEDIA_SQL, [
      id,
      viewerId ?? null,
      viewerId ?? null,
    ]);
    if (!rows[0]) {
      throw new NotFoundException(MEDIA_NOT_FOUND);
    }
    return rows[0];
  }

  // 404 for an unknown, deleted or suspended community, then 403 unless the
  // actor created it.
  private async lockCommunity(
    executor: Executor,
    name: string,
    actorId: string,
    forUpdate: boolean,
  ) {
    const [rows] = await executor.execute<
      (RowDataPacket & {
        id: string;
        creator_id: string;
        icon_media_id: string | null;
        banner_media_id: string | null;
      })[]
    >(
      `SELECT id, creator_id, icon_media_id, banner_media_id FROM communities WHERE name = ? AND ${COMMUNITY_VISIBLE_PREDICATE} LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [name],
    );
    const community = rows[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    if (community.creator_id !== actorId) {
      throw new ForbiddenException(
        'Only the community creator can edit the community',
      );
    }
    return community;
  }

  private recordCommunityUpdate(
    connection: PoolConnection,
    communityId: string,
    slot: CommunityImageSlot,
    actorId: string,
  ): Promise<void> {
    return this.moderationLog.record(connection, {
      actorId,
      communityId,
      action: 'community_updated',
      targetType: 'community',
      targetId: communityId,
      metadata: { fields: slot },
    });
  }

  private async release(
    connection: PoolConnection,
    mediaId: string | null,
  ): Promise<void> {
    if (mediaId) {
      await connection.execute<ResultSetHeader>(RELEASE_MEDIA_SQL, [mediaId]);
    }
  }

  private async inTransaction<T>(
    work: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    let started = false;
    try {
      await connection.beginTransaction();
      started = true;
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      if (started) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
