import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { MEDIA_CONFIG, type MediaConfig } from './media.config';
import {
  DELETE_RELEASED_MEDIA_SQL,
  RELEASED_MEDIA_SQL,
  RELEASE_STALE_UPLOADS_SQL,
} from './media-sql';
import { MEDIA_STORAGE, type MediaStorage } from './storage/media-storage';

export interface SweepResult {
  released: number;
  deleted: number;
  failed: number;
}

// Frees media no one uses any more. A release (a deleted post, account or
// community, a replaced avatar, DELETE /media/:id) only marks the row in the
// deleting transaction, so the delete never waits on storage and never fails
// because of it; this sweep then deletes the object and the row. It also
// releases uploads never attached within the pending window. Every step is
// idempotent and guarded by MEDIA_REFERENCED_SQL, so it may run on several
// instances at once, and a failed object delete is retried on the next run.
@Injectable()
export class MediaCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<SweepResult>;

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.sweepIntervalSeconds > 0) {
      this.timer = setInterval(() => {
        void this.sweepSafely();
      }, this.config.sweepIntervalSeconds * 1000);
      // Never keeps the process alive on its own.
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  // After a release the API asks for a sweep at once, without waiting for
  // it: the response does not depend on storage.
  requestSweep(): void {
    void this.sweepSafely();
  }

  // One sweep at a time per process; a request during a run joins it.
  sweep(batchSize = 100): Promise<SweepResult> {
    this.running ??= this.run(batchSize).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async sweepSafely(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      this.logger.error(
        `Media sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async run(batchSize: number): Promise<SweepResult> {
    const [stale] = await this.pool.execute<ResultSetHeader>(
      RELEASE_STALE_UPLOADS_SQL,
      [this.config.pendingTtlHours],
    );
    const [rows] = await this.pool.execute<
      (RowDataPacket & { id: string; storage_key: string })[]
    >(RELEASED_MEDIA_SQL, [batchSize]);
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        // The object first: a row without its object is never left behind
        // for a reader, and a failure here keeps the row for the next run.
        await this.storage.delete(row.storage_key);
        const [result] = await this.pool.execute<ResultSetHeader>(
          DELETE_RELEASED_MEDIA_SQL,
          [row.id],
        );
        deleted += result.affectedRows;
      } catch (error) {
        failed += 1;
        // The id only: never the key's bucket, the storage error's body or
        // credentials.
        this.logger.warn(
          `Could not delete released media ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { released: stale.affectedRows, deleted, failed };
  }
}
