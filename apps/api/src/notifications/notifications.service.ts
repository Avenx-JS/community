import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  assertNotificationEntry,
  buildNotificationMetadata,
  type NotificationEntry,
} from './notification-metadata';

// Rows per multi-row INSERT in recordMany. Eight placeholders per row keeps a
// full batch far below MySQL's 65,535 prepared-statement placeholder limit.
export const NOTIFICATION_BATCH_SIZE = 500;

const INSERT_COLUMNS =
  'INSERT INTO notifications (id, recipient_id, type, actor_id, subject_type, subject_id, community_id, metadata) VALUES ';
const ROW_PLACEHOLDERS = '(?, ?, ?, ?, ?, ?, ?, ?)';
// A repeated write of the same event hits the unique key on
// (recipient_id, type, subject_type, subject_id) and leaves the row untouched.
const ON_DUPLICATE = ' ON DUPLICATE KEY UPDATE id = id';

function isNotificationEntry(
  value: PoolConnection | NotificationEntry,
): value is NotificationEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'recipientId' in value &&
    'type' in value
  );
}

// The single write path for notifications; producers never insert directly.
//
// Transaction policy: a producer that is inside a transaction passes its own
// connection, so the notification commits or rolls back with the action that
// caused it. There is then no window in which, say, a comment exists but its
// notification was lost. The cost is that a failed notification write rolls
// back the user's action. That is accepted: the write is a bounded insert
// whose only contention is its unique key, and writing after commit would
// silently drop notifications from an inbox whose purpose is not to lose
// them. This is deliberately the opposite of AuthService.logoutAll, which runs
// after its transaction because token revocation has an independent
// enforcement backstop; a notification has none. Do not move notification
// writes after commit without revisiting this.
@Injectable()
export class NotificationsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  record(connection: PoolConnection, entry: NotificationEntry): Promise<void>;
  record(entry: NotificationEntry): Promise<void>;
  async record(
    connectionOrEntry: PoolConnection | NotificationEntry,
    maybeEntry?: NotificationEntry,
  ): Promise<void> {
    if (maybeEntry !== undefined) {
      if (isNotificationEntry(connectionOrEntry)) {
        throw new TypeError('Expected a database connection');
      }
      await this.insert(connectionOrEntry, [maybeEntry]);
      return;
    }

    if (!isNotificationEntry(connectionOrEntry)) {
      throw new TypeError('Expected a notification entry');
    }
    const connection = await this.pool.getConnection();
    try {
      await this.insert(connection, [connectionOrEntry]);
    } finally {
      connection.release();
    }
  }

  // Fan-out form: one multi-row INSERT per NOTIFICATION_BATCH_SIZE entries.
  // Requires the caller's connection, so a multi-batch fan-out is atomic with
  // the action. Every entry is validated before the first statement runs. The
  // producer owns the ceiling on how many recipients one action may notify.
  async recordMany(
    connection: PoolConnection,
    entries: readonly NotificationEntry[],
  ): Promise<void> {
    if (!Array.isArray(entries) || isNotificationEntry(connection)) {
      throw new TypeError(
        'Expected a database connection and an array of notification entries',
      );
    }
    await this.insert(connection, entries);
  }

  private async insert(
    connection: PoolConnection,
    entries: readonly NotificationEntry[],
  ): Promise<void> {
    const rows = entries.flatMap((entry) => {
      if (!isNotificationEntry(entry)) {
        throw new TypeError('Expected a notification entry');
      }
      assertNotificationEntry(entry);
      const metadata = buildNotificationMetadata(entry);
      // Never tell users about their own actions. Moderation types have no
      // actor, so they are never suppressed.
      if (entry.actorId !== null && entry.recipientId === entry.actorId) {
        return [];
      }
      return [
        [
          randomUUID(),
          entry.recipientId,
          entry.type,
          entry.actorId,
          entry.subjectType,
          entry.subjectId,
          entry.communityId,
          metadata === null ? null : JSON.stringify(metadata),
        ],
      ];
    });

    for (let start = 0; start < rows.length; start += NOTIFICATION_BATCH_SIZE) {
      const batch = rows.slice(start, start + NOTIFICATION_BATCH_SIZE);
      await connection.execute(
        `${INSERT_COLUMNS}${batch.map(() => ROW_PLACEHOLDERS).join(', ')}${ON_DUPLICATE}`,
        batch.flat(),
      );
    }
  }
}
