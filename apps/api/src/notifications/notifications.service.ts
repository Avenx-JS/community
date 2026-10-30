import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { COMMUNITY_NEW_POST_RECIPIENTS_SQL } from '../communities/community-notification-recipients';
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

// A community_post entry before its recipients are known: the fan-out selects
// them from the community's eligible members.
export type CommunityPostFanOut = Omit<
  Extract<NotificationEntry, { type: 'community_post' }>,
  'recipientId'
>;

export interface CommunityPostFanOutResult {
  recipients: number;
  written: boolean;
}

// Both statements wrap the community new-post recipient contract unchanged and
// only add the author exclusion. Bound values: community id, author id.
const ELIGIBLE_RECIPIENTS = `(${COMMUNITY_NEW_POST_RECIPIENTS_SQL} AND s.user_id <> ?) eligible`;

export const COMMUNITY_POST_RECIPIENT_COUNT_SQL = `SELECT COUNT(*) AS recipients FROM ${ELIGIBLE_RECIPIENTS}`;

// One statement however many members are notified. MySQL's UUID() yields the
// same 36-character 8-4-4-4-12 lowercase form as randomUUID(), though as a
// version 1 rather than a version 4 UUID; nothing reads meaning into an id,
// and inbox ownership is enforced by recipient_id, not by unguessable ids.
export const COMMUNITY_POST_FAN_OUT_SQL = `INSERT INTO notifications (id, recipient_id, type, actor_id, subject_type, subject_id, community_id, metadata) SELECT UUID(), eligible.user_id, 'community_post', ?, 'post', ?, ?, ? FROM ${ELIGIBLE_RECIPIENTS}${ON_DUPLICATE}`;

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

  // community_post fan-out: counts the eligible members (excluding the
  // author) and, unless there are more than maxRecipients, writes one row per
  // member with a single INSERT ... SELECT on the caller's connection. At most
  // two round trips, whatever the member count. Above the ceiling nothing is
  // written; the producer owns the ceiling and how a skip is reported.
  async recordCommunityPost(
    connection: PoolConnection,
    entry: CommunityPostFanOut,
    maxRecipients: number,
  ): Promise<CommunityPostFanOutResult> {
    // Validated as if addressed to the author: every row shares this shape
    // and metadata, and the recipients themselves come from the database.
    const template = {
      ...entry,
      recipientId: entry.actorId,
    } as NotificationEntry;
    if (template.type !== 'community_post') {
      throw new TypeError('Expected a community_post notification');
    }
    assertNotificationEntry(template);
    const metadata = buildNotificationMetadata(template);

    const recipientValues = [entry.communityId, entry.actorId];
    const [counts] = await connection.execute<
      (RowDataPacket & { recipients: number | string })[]
    >(COMMUNITY_POST_RECIPIENT_COUNT_SQL, recipientValues);
    const recipients = Number(counts[0]?.recipients ?? 0);
    if (recipients === 0 || recipients > maxRecipients) {
      return { recipients, written: false };
    }

    await connection.execute(COMMUNITY_POST_FAN_OUT_SQL, [
      entry.actorId,
      entry.subjectId,
      entry.communityId,
      metadata === null ? null : JSON.stringify(metadata),
      ...recipientValues,
    ]);
    return { recipients, written: true };
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
