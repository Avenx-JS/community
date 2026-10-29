import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import {
  MODERATION_NOTIFICATION_TYPES,
  type NotificationSubjectType,
  type NotificationType,
} from './notification-metadata';

interface NotificationRow extends RowDataPacket {
  id: string;
  type: NotificationType;
  subject_type: NotificationSubjectType;
  subject_id: string;
  community_id: string | null;
  metadata: unknown;
  read_at: Date | string | null;
  created_at: Date | string;
}

export interface NotificationDto {
  id: string;
  type: NotificationType;
  actor_username: string | null;
  subject_type: NotificationSubjectType;
  subject_id: string;
  community_id: string | null;
  community_name: string | null;
  metadata: Record<string, string> | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationListDto {
  items: NotificationDto[];
  page: number;
  limit: number;
  total: number;
}

export interface UnreadCountDto {
  unread: number;
}

// Rows render from the notification alone: no join to the subject, actor or
// community, so a deleted post, comment, account or rename never drops or
// breaks a row. actor_id is deliberately not selected.
const NOTIFICATION_COLUMNS =
  'id, type, subject_type, subject_id, community_id, metadata, read_at, created_at';

// Read-side allowlist over the snapshot keys buildNotificationMetadata writes.
// actor_username and community_name are lifted to top-level fields.
const RETURNED_METADATA_KEYS = [
  'post_id',
  'parent_comment_id',
  'post_title',
  'excerpt',
  'status',
  'restriction_type',
  'expires_at',
] as const;

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return parseMetadata(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toIsoString(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function toNotificationDto(row: NotificationRow): NotificationDto {
  const snapshot = parseMetadata(row.metadata);
  const metadata: Record<string, string> = {};
  for (const key of RETURNED_METADATA_KEYS) {
    const value = snapshot[key];
    if (typeof value === 'string') {
      metadata[key] = value;
    }
  }

  return {
    id: row.id,
    type: row.type,
    // Never disclose who moderated, even if a row was written outside the
    // service with a username in it.
    actor_username: MODERATION_NOTIFICATION_TYPES.includes(row.type)
      ? null
      : stringOrNull(snapshot.actor_username),
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    community_id: row.community_id,
    community_name: stringOrNull(snapshot.community_name),
    metadata: Object.keys(metadata).length === 0 ? null : metadata,
    read_at: toIsoString(row.read_at),
    created_at: new Date(row.created_at).toISOString(),
  };
}

// Builds the listing and count statements. The recipient is always the first
// bound value and comes only from the caller's validated identity. Each
// filter combination keeps a prefix of one of migration 010's indexes:
// (recipient_id, created_at, id), (recipient_id, read_at, created_at) and
// (recipient_id, type, created_at).
export function buildNotificationListQuery(
  recipientId: string,
  query: ListNotificationsDto,
): { sql: string; countSql: string; values: (string | number)[] } {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const filters = ['recipient_id = ?'];
  const values: string[] = [recipientId];

  if (query.read === false) {
    filters.push('read_at IS NULL');
  } else if (query.read === true) {
    filters.push('read_at IS NOT NULL');
  }
  if (query.type !== undefined) {
    filters.push('type = ?');
    values.push(query.type);
  }
  if (query.community_id !== undefined) {
    filters.push('community_id = ?');
    values.push(query.community_id);
  }

  const where = filters.join(' AND ');
  const order = query.sort === 'oldest' ? 'ASC' : 'DESC';
  return {
    sql: `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE ${where} ORDER BY created_at ${order}, id ${order} LIMIT ? OFFSET ?`,
    countSql: `SELECT COUNT(*) AS total FROM notifications WHERE ${where}`,
    values: [...values, limit, (page - 1) * limit],
  };
}

export const UNREAD_COUNT_SQL =
  'SELECT COUNT(*) AS unread FROM notifications WHERE recipient_id = ? AND read_at IS NULL';

// Read side of the inbox. Every method takes the recipient from the
// authenticated request; nothing here accepts a recipient from client input.
// Reads never modify read_at.
@Injectable()
export class NotificationInboxService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async list(
    recipientId: string,
    query: ListNotificationsDto,
  ): Promise<NotificationListDto> {
    const { sql, countSql, values } = buildNotificationListQuery(
      recipientId,
      query,
    );
    const [rows] = await this.pool.execute<NotificationRow[]>(sql, values);
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(countSql, values.slice(0, -2));

    return {
      items: rows.map(toNotificationDto),
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  async unreadCount(recipientId: string): Promise<UnreadCountDto> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { unread: number | string })[]
    >(UNREAD_COUNT_SQL, [recipientId]);
    return { unread: Number(rows[0]?.unread ?? 0) };
  }

  // Another user's notification is indistinguishable from a missing one, so
  // its existence is never confirmed.
  async findOne(recipientId: string, id: string): Promise<NotificationDto> {
    const [rows] = await this.pool.execute<NotificationRow[]>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = ? AND recipient_id = ? LIMIT 1`,
      [id, recipientId],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Notification not found');
    }
    return toNotificationDto(row);
  }
}
