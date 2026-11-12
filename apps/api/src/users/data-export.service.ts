import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { readPositiveInteger } from '../common/read-positive-integer';
import { UserPreferencesService } from './user-preferences.service';

// Personal data exports (GET /users/me/export, migration 037): the
// counterpart of DELETE /users/me. Built asynchronously, downloadable once,
// and gone after DATA_EXPORT_TTL_HOURS. What it contains and leaves out is
// set out in the README ("Exporting your data").

export type DataExportStatus =
  'pending' | 'ready' | 'failed' | 'downloaded' | 'expired';

export interface DataExportDto {
  id: string;
  status: DataExportStatus;
  created_at: string;
  // When a ready export stops being downloadable; null until it is ready.
  expires_at: string | null;
}

interface ExportRow extends RowDataPacket {
  id: string;
  status: DataExportStatus;
  created_at: Date | string;
  expires_at: Date | string | null;
}

export const EXPORT_FORMAT = 'community-data-export/1';

// Ready exports past their expiry lose their payload; pending ones whose
// build never finished (a restart) fail, so a new one can be requested.
export const EXPIRE_EXPORTS_SQL =
  "UPDATE data_exports SET status = 'expired', payload = NULL WHERE status = 'ready' AND expires_at <= UTC_TIMESTAMP()";
export const FAIL_STALE_EXPORTS_SQL =
  "UPDATE data_exports SET status = 'failed' WHERE status = 'pending' AND created_at < CURRENT_TIMESTAMP - INTERVAL ? MINUTE";

// The account's own data, section by section. Never a password hash, a
// token, another person's private data, or anything said about the account
// by others (reports about it, moderators' notes): only what it wrote, chose
// or was shown. Every statement is bound to the account id alone.
export const EXPORT_SECTIONS: Array<[string, string]> = [
  [
    'account',
    'SELECT username, email, email_verified_at, display_name, bio, created_at, last_seen_at FROM users WHERE id = ?',
  ],
  [
    'posts',
    'SELECT p.id, p.title, p.content, p.type, c.name AS community, p.created_at, p.edited_at, p.removed_at FROM posts p JOIN communities c ON c.id = p.community_id WHERE p.author_id = ? ORDER BY p.created_at, p.id',
  ],
  [
    'comments',
    'SELECT id, post_id, parent_id, content, created_at, edited_at, removed_at FROM comments WHERE author_id = ? ORDER BY created_at, id',
  ],
  [
    'votes',
    'SELECT target_type, target_id, value, created_at FROM votes WHERE user_id = ? ORDER BY created_at, id',
  ],
  [
    'subscriptions',
    'SELECT c.name AS community, s.created_at FROM community_subscriptions s JOIN communities c ON c.id = s.community_id WHERE s.user_id = ? ORDER BY s.created_at',
  ],
  [
    'community_notification_preferences',
    'SELECT c.name AS community, p.new_posts FROM community_notification_preferences p JOIN communities c ON c.id = p.community_id WHERE p.user_id = ?',
  ],
  [
    'communities_created',
    'SELECT name, description, created_at, deleted_at FROM communities WHERE creator_id = ? ORDER BY created_at',
  ],
  [
    'moderator_of',
    'SELECT c.name AS community, m.created_at FROM community_moderators m JOIN communities c ON c.id = m.community_id WHERE m.user_id = ? ORDER BY m.created_at',
  ],
  [
    'saved_posts',
    'SELECT post_id, created_at FROM saved_posts WHERE user_id = ? ORDER BY created_at',
  ],
  [
    'blocked_users',
    'SELECT u.username, b.created_at FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at',
  ],
  [
    'reports_filed',
    'SELECT id, target_type, reason, description, status, community_status, created_at, withdrawn_at FROM user_reports WHERE reporter_id = ? ORDER BY created_at, id',
  ],
  [
    'notifications',
    'SELECT type, subject_type, subject_id, created_at, read_at FROM notifications WHERE recipient_id = ? ORDER BY created_at, id',
  ],
  [
    'media',
    'SELECT id, purpose, kind, mime_type, size_bytes, width, height, created_at FROM media WHERE uploader_id = ? AND released_at IS NULL ORDER BY created_at',
  ],
  [
    'sessions',
    'SELECT created_at, last_used_at, ip_prefix, user_agent FROM auth_sessions WHERE user_id = ? ORDER BY created_at',
  ],
];

@Injectable()
export class DataExportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataExportService.name);
  private readonly ttlHours = readPositiveInteger('DATA_EXPORT_TTL_HOURS', 24);
  private readonly pendingTimeoutMinutes = readPositiveInteger(
    'DATA_EXPORT_PENDING_TIMEOUT_MINUTES',
    60,
  );
  private readonly sweepSeconds = readPositiveInteger(
    'DATA_EXPORT_SWEEP_INTERVAL_SECONDS',
    600,
  );
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly preferences: UserPreferencesService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {
        this.logger.warn('Data export sweep failed');
      });
    }, this.sweepSeconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  // POST /users/me/export: 202 at once; the build runs detached. One export
  // at a time per account (409 while one is pending), counted under the
  // account's row lock.
  async request(userId: string): Promise<DataExportDto> {
    await this.sweep();
    const id = randomUUID();
    await this.inTransaction(async (connection) => {
      const [users] = await connection.execute<RowDataPacket[]>(
        'SELECT id FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
        [userId],
      );
      if (!users[0]) {
        throw new NotFoundException('User not found');
      }
      const [pending] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM data_exports WHERE user_id = ? AND status = 'pending' LIMIT 1",
        [userId],
      );
      if (pending[0]) {
        throw new ConflictException('An export is already being prepared');
      }
      await connection.execute<ResultSetHeader>(
        'INSERT INTO data_exports (id, user_id) VALUES (?, ?)',
        [id, userId],
      );
    });
    setImmediate(() => {
      void this.build(id, userId);
    });
    return this.status(userId, id);
  }

  // GET /users/me/export/:id while it is not ready: its state. Another
  // account's export is 404.
  async status(userId: string, id: string): Promise<DataExportDto> {
    const [rows] = await this.pool.execute<ExportRow[]>(
      'SELECT id, status, created_at, expires_at FROM data_exports WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Export not found');
    }
    return {
      id: row.id,
      status: row.status,
      created_at: new Date(row.created_at).toISOString(),
      expires_at: row.expires_at
        ? new Date(row.expires_at).toISOString()
        : null,
    };
  }

  // The file, exactly once: the payload is read and cleared in one
  // transaction, so two concurrent downloads cannot both get it. Every
  // other state answers with the state (pending), 409 (failed) or 410
  // (downloaded or expired).
  async download(
    userId: string,
    id: string,
  ): Promise<
    { kind: 'file'; body: Buffer } | { kind: 'status'; export: DataExportDto }
  > {
    await this.sweep();
    const current = await this.status(userId, id);
    if (current.status === 'pending') {
      return { kind: 'status', export: current };
    }
    if (current.status === 'failed') {
      throw new ConflictException('The export failed; request a new one');
    }
    if (current.status !== 'ready') {
      throw new GoneException(
        current.status === 'downloaded'
          ? 'This export was already downloaded; request a new one'
          : 'This export has expired; request a new one',
      );
    }
    const body = await this.inTransaction(async (connection) => {
      const [rows] = await connection.execute<
        (RowDataPacket & { payload: Buffer | null })[]
      >(
        "SELECT payload FROM data_exports WHERE id = ? AND user_id = ? AND status = 'ready' AND expires_at > UTC_TIMESTAMP() LIMIT 1 FOR UPDATE",
        [id, userId],
      );
      const payload = rows[0]?.payload;
      if (!payload) {
        throw new GoneException('This export is no longer available');
      }
      await connection.execute<ResultSetHeader>(
        "UPDATE data_exports SET status = 'downloaded', downloaded_at = UTC_TIMESTAMP(), payload = NULL WHERE id = ? AND status = 'ready'",
        [id],
      );
      return payload;
    });
    return { kind: 'file', body };
  }

  // Expires and fails stale exports; idempotent, also run by the timer.
  async sweep(): Promise<void> {
    await this.pool.execute<ResultSetHeader>(EXPIRE_EXPORTS_SQL);
    await this.pool.execute<ResultSetHeader>(FAIL_STALE_EXPORTS_SQL, [
      this.pendingTimeoutMinutes,
    ]);
  }

  // Never rejects: nothing awaits it. A failure marks the export failed.
  async build(id: string, userId: string): Promise<void> {
    try {
      const data: Record<string, unknown> = {
        format: EXPORT_FORMAT,
        generated_at: new Date().toISOString(),
      };
      for (const [section, sql] of EXPORT_SECTIONS) {
        const [rows] = await this.pool.execute<RowDataPacket[]>(sql, [userId]);
        data[section] = section === 'account' ? (rows[0] ?? null) : rows;
      }
      data.preferences = await this.preferences.get(userId);
      const payload = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
      await this.pool.execute<ResultSetHeader>(
        "UPDATE data_exports SET status = 'ready', payload = ?, size_bytes = ?, completed_at = UTC_TIMESTAMP(), expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR) WHERE id = ? AND status = 'pending'",
        [payload, payload.length, this.ttlHours, id],
      );
    } catch {
      this.logger.warn(`Data export ${id} failed`);
      await this.pool
        .execute<ResultSetHeader>(
          "UPDATE data_exports SET status = 'failed' WHERE id = ? AND status = 'pending'",
          [id],
        )
        .catch(() => undefined);
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
