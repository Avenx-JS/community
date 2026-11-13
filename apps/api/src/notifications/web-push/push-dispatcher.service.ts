import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../../auth/auth.service';
import { inTransaction } from '../../communities/community-access';
import { eitherBlockedSql } from '../../users/user-block-policy.service';
import {
  NOTIFICATION_COLUMNS,
  toNotificationDto,
  type NotificationRow,
} from '../notification-inbox.service';
import {
  PUSH_CONFIG,
  PUSH_TRANSPORT,
  type PushConfig,
  type PushTransport,
} from './push-config';
import {
  base64url,
  encryptPushPayload,
  vapidAuthorization,
} from './web-push-crypto';

const N_COLUMNS = NOTIFICATION_COLUMNS.split(', ')
  .map((column) => `n.${column}`)
  .join(', ');

// The oldest pending notifications, locked so that every instance claims
// different ones (SKIP LOCKED), with whether each may be pushed:
// - recent enough (PUSH_MAX_AGE_SECONDS): a late push is noise;
// - the recipient's push_notifications preference is on (default on);
// - a new post in a community only while that membership's new_posts
//   setting is on (/communities/:name/notification-preferences), read now,
//   so a later change is honoured;
// - not from an account blocked in either direction, as the inbox hides it.
// Values: max age in seconds, batch size.
export const CLAIM_PUSH_SQL = `SELECT ${N_COLUMNS}, n.recipient_id,
         (n.created_at >= UTC_TIMESTAMP() - INTERVAL ? SECOND
          AND COALESCE(preferences.push_notifications, TRUE)
          AND (n.type <> 'community_post' OR COALESCE(membership.new_posts, TRUE))
          AND (n.actor_id IS NULL OR NOT ${eitherBlockedSql('n.recipient_id', 'n.actor_id')})
         ) AS deliver
       FROM notifications n
       LEFT JOIN user_preferences preferences ON preferences.user_id = n.recipient_id
       LEFT JOIN community_notification_preferences membership
         ON membership.user_id = n.recipient_id AND membership.community_id = n.community_id
       WHERE n.push_dispatched_at IS NULL
       ORDER BY n.created_at, n.id
       LIMIT ?
       FOR UPDATE OF n SKIP LOCKED`;

export const markDispatchedSql = (count: number) =>
  `UPDATE notifications SET push_dispatched_at = UTC_TIMESTAMP() WHERE id IN (${new Array(count).fill('?').join(', ')})`;

export const subscriptionsOfSql = (count: number) =>
  `SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions
       WHERE user_id IN (${new Array(count).fill('?').join(', ')})
         AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())`;

export const expiredSubscriptionsSql = (count: number) =>
  `DELETE FROM push_subscriptions WHERE user_id IN (${new Array(count).fill('?').join(', ')}) AND expires_at <= UTC_TIMESTAMP()`;

export const PUSH_SUCCEEDED_SQL =
  'UPDATE push_subscriptions SET last_success_at = UTC_TIMESTAMP(), failure_count = 0 WHERE id = ?';
export const PUSH_GONE_SQL = 'DELETE FROM push_subscriptions WHERE id = ?';
export const PUSH_FAILED_SQL =
  'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?';
// Values: id, the failure limit.
export const PUSH_GIVE_UP_SQL =
  'DELETE FROM push_subscriptions WHERE id = ? AND failure_count >= ?';

// A push service accepts 4096 bytes of record, less the 86-byte header and
// tag; the payload stays well below, falling back to the bare reference.
const PAYLOAD_LIMIT = 3000;

interface ClaimedRow extends NotificationRow {
  recipient_id: string;
  deliver: number | string | boolean;
}

interface SubscriptionRow extends RowDataPacket {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface DispatchSummary {
  claimed: number;
  sent: number;
  removed: number;
}

// Web Push delivery. Notifications are written inside their causes'
// transactions, so the dispatcher reads committed rows only, every
// PUSH_DISPATCH_INTERVAL_SECONDS: a rolled-back cause never pushes. Each
// notification is claimed once across instances and then never retried: a
// push is a nudge, the inbox is the record. Disabled without VAPID keys.
@Injectable()
export class PushDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushDispatcherService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    @Inject(PUSH_CONFIG) private readonly config: PushConfig,
    @Inject(PUSH_TRANSPORT) private readonly transport: PushTransport,
  ) {}

  onModuleInit(): void {
    if (!this.config.vapid || process.env.PUSH_DISPATCH_DISABLED === 'true') {
      return;
    }
    this.timer = setInterval(() => {
      void this.dispatchOnce().catch(() => {
        this.logger.warn('Push dispatch failed');
      });
    }, this.config.dispatchIntervalSeconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async dispatchOnce(): Promise<DispatchSummary> {
    const summary: DispatchSummary = { claimed: 0, sent: 0, removed: 0 };
    if (!this.config.vapid || this.running) {
      return summary;
    }
    this.running = true;
    try {
      const claimed = await inTransaction(this.pool, async (connection) => {
        const [rows] = await connection.execute<ClaimedRow[]>(CLAIM_PUSH_SQL, [
          this.config.maxAgeSeconds,
          this.config.batchSize,
        ]);
        if (rows.length > 0) {
          await connection.execute<ResultSetHeader>(
            markDispatchedSql(rows.length),
            rows.map((row) => row.id),
          );
        }
        return rows;
      });
      summary.claimed = claimed.length;
      const deliverable = claimed.filter((row) => Number(row.deliver) === 1);
      if (deliverable.length === 0) {
        return summary;
      }

      const recipients = [
        ...new Set(deliverable.map((row) => row.recipient_id)),
      ];
      const [expired] = await this.pool.execute<ResultSetHeader>(
        expiredSubscriptionsSql(recipients.length),
        recipients,
      );
      summary.removed += expired.affectedRows;
      const [subscriptions] = await this.pool.execute<SubscriptionRow[]>(
        subscriptionsOfSql(recipients.length),
        recipients,
      );
      for (const row of deliverable) {
        const payload = this.payload(row);
        for (const subscription of subscriptions) {
          if (subscription.user_id !== row.recipient_id) continue;
          const outcome = await this.push(subscription, payload);
          if (outcome === 'sent') summary.sent += 1;
          if (outcome === 'removed') summary.removed += 1;
        }
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  // The inbox's own DTO (moderation notifications carry no actor), or only
  // its reference if that would be too large.
  private payload(row: ClaimedRow): Buffer {
    const full = Buffer.from(
      JSON.stringify({ notification: toNotificationDto(row) }),
    );
    if (full.length <= PAYLOAD_LIMIT) {
      return full;
    }
    return Buffer.from(
      JSON.stringify({ notification: { id: row.id, type: row.type } }),
    );
  }

  private async push(
    subscription: SubscriptionRow,
    payload: Buffer,
  ): Promise<'sent' | 'removed' | 'failed'> {
    let status: number;
    try {
      const body = encryptPushPayload(
        payload,
        base64url.decode(subscription.p256dh),
        base64url.decode(subscription.auth),
      );
      ({ status } = await this.transport.send({
        endpoint: subscription.endpoint,
        headers: {
          Authorization: vapidAuthorization(
            subscription.endpoint,
            this.config.vapid!,
          ),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(this.config.ttlSeconds),
          Urgency: 'normal',
        },
        body,
      }));
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      await this.pool.execute(PUSH_SUCCEEDED_SQL, [subscription.id]);
      return 'sent';
    }
    // RFC 8030 section 7.3: the subscription is gone for good.
    if (status === 404 || status === 410) {
      await this.pool.execute(PUSH_GONE_SQL, [subscription.id]);
      return 'removed';
    }
    // Anything else may pass; repeated failures end the subscription too.
    await this.pool.execute(PUSH_FAILED_SQL, [subscription.id]);
    const [given] = await this.pool.execute<ResultSetHeader>(PUSH_GIVE_UP_SQL, [
      subscription.id,
      this.config.maxFailures,
    ]);
    return given.affectedRows > 0 ? 'removed' : 'failed';
  }
}
