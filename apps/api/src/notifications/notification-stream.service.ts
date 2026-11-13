import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Subscription } from 'rxjs';
import { hashOpaqueToken, MYSQL_POOL } from '../auth/auth.service';
import { SessionEvents } from '../auth/session-events';
import { ACTIVE_USER_RESTRICTION_PREDICATE } from '../common/active-user-restriction';
import { readPositiveInteger } from '../common/read-positive-integer';
import { eitherBlockedSql } from '../users/user-block-policy.service';
import {
  NotificationInboxService,
  NOTIFICATION_COLUMNS,
  toNotificationDto,
  UNREAD_COUNT_SQL,
  type NotificationRow,
} from './notification-inbox.service';

const placeholders = (count: number) => new Array(count).fill('?').join(', ');
const N_COLUMNS = NOTIFICATION_COLUMNS.split(', ')
  .map((column) => `n.${column}`)
  .join(', ');

// The streams' sessions that are still good: the access token unexpired and
// not revoked (logout, DELETE /auth/sessions/:id, logout-all, account
// deletion all delete the row), the account not deleted and not under an
// active suspension or ban. Values: token hashes.
export const liveStreamSessionsSql = (count: number) =>
  `SELECT s.token_hash, s.user_id FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash IN (${placeholders(count)})
         AND s.expires_at > UTC_TIMESTAMP()
         AND u.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM user_restrictions
           WHERE user_restrictions.user_id = s.user_id
             AND ${ACTIVE_USER_RESTRICTION_PREDICATE}
         )`;

// The recent notifications of the connected accounts, as the inbox shows
// them (blocked actors left out). Committed rows only: notifications are
// written inside their causes' transactions, so the stream never announces
// one that is rolled back. Values: recipients, then the window in seconds.
export const recentNotificationsSql = (count: number) =>
  `SELECT ${N_COLUMNS}, n.recipient_id FROM notifications n
       WHERE n.recipient_id IN (${placeholders(count)})
         AND n.created_at >= UTC_TIMESTAMP() - INTERVAL ? SECOND
         AND (n.actor_id IS NULL OR NOT ${eitherBlockedSql('n.recipient_id', 'n.actor_id')})
       ORDER BY n.created_at, n.id`;

// Values: ticket hash, user, token hash, lifetime in seconds.
export const INSERT_STREAM_TICKET_SQL =
  'INSERT INTO notification_stream_tickets (ticket_hash, user_id, token_hash, expires_at) VALUES (?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? SECOND)';
// Single use: the update succeeds once, and only while unexpired.
export const USE_STREAM_TICKET_SQL =
  'UPDATE notification_stream_tickets SET used_at = UTC_TIMESTAMP() WHERE ticket_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()';
export const STREAM_TICKET_SQL =
  'SELECT user_id, token_hash FROM notification_stream_tickets WHERE ticket_hash = ? LIMIT 1';
export const SWEEP_STREAM_TICKETS_SQL =
  'DELETE FROM notification_stream_tickets WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 HOUR';

export type StreamEndReason = 'session_ended' | 'replaced' | 'shutdown';

interface StreamConnection {
  id: string;
  userId: string;
  tokenHash: string;
  response: Response;
  // Notification ids already announced, or present when it connected; kept
  // to the ids inside the look-back window.
  seen: Set<string>;
}

export interface StreamIdentity {
  userId: string;
  tokenHash: string;
}

type RecentRow = NotificationRow & { recipient_id: string };

// GET /notifications/stream: Server-Sent Events, per instance. Each
// connection belongs to one access token. Every poll interval the instance
// reads the recent committed notifications of its connected accounts and
// sends the new ones, then each touched account's unread count. Ended by
// the session ending, the account being restricted or deleted (checked
// every NOTIFICATION_STREAM_REVALIDATE_SECONDS, and at once on this instance
// through SessionEvents), by a newer connection of the same
// account beyond NOTIFICATION_STREAMS_PER_ACCOUNT, or by shutdown.
@Injectable()
export class NotificationStreamService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationStreamService.name);
  private readonly byUser = new Map<string, StreamConnection[]>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly subscriptions: Subscription[] = [];
  private polling = false;
  readonly perAccount = readPositiveInteger(
    'NOTIFICATION_STREAMS_PER_ACCOUNT',
    5,
  );
  readonly maxStreams = readPositiveInteger('NOTIFICATION_STREAMS_MAX', 10000);
  private readonly heartbeatSeconds = readPositiveInteger(
    'NOTIFICATION_STREAM_HEARTBEAT_SECONDS',
    25,
  );
  private readonly pollMs = readPositiveInteger(
    'NOTIFICATION_STREAM_POLL_MS',
    2000,
  );
  private readonly revalidateSeconds = readPositiveInteger(
    'NOTIFICATION_STREAM_REVALIDATE_SECONDS',
    15,
  );
  private readonly lookbackSeconds = readPositiveInteger(
    'NOTIFICATION_STREAM_LOOKBACK_SECONDS',
    60,
  );
  readonly ticketSeconds = readPositiveInteger(
    'NOTIFICATION_STREAM_TICKET_TTL_SECONDS',
    60,
  );

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly sessions: SessionEvents,
    private readonly inbox: NotificationInboxService,
  ) {}

  onModuleInit(): void {
    this.subscriptions.push(
      this.sessions.changed.subscribe((userId) => {
        void this.revalidate(userId).catch(() => undefined);
      }),
      this.inbox.unreadChanged.subscribe((userId) => {
        void this.refreshUnread(userId).catch(() => undefined);
      }),
    );
    const every = (ms: number, work: () => Promise<void> | void) => {
      const timer = setInterval(() => {
        void Promise.resolve(work()).catch(() => {
          this.logger.warn('Notification stream maintenance failed');
        });
      }, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(this.pollMs, () => this.poll());
    every(this.heartbeatSeconds * 1000, () => this.heartbeat());
    every(this.revalidateSeconds * 1000, () => this.revalidate());
    every(3_600_000, async () => {
      await this.pool.execute(SWEEP_STREAM_TICKETS_SQL);
    });
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    for (const timer of this.timers) clearInterval(timer);
    for (const connection of this.connections()) {
      this.end(connection, 'shutdown');
    }
  }

  get size(): number {
    return this.connections().length;
  }

  // POST /notifications/stream-tickets: for EventSource, which cannot send
  // an Authorization header. Bound to the access token that minted it.
  async mintTicket(
    userId: string,
    accessToken: string,
  ): Promise<{ ticket: string; expires_in: number }> {
    const ticket = randomBytes(32).toString('base64url');
    await this.pool.execute<ResultSetHeader>(INSERT_STREAM_TICKET_SQL, [
      hashOpaqueToken(ticket),
      userId,
      hashOpaqueToken(accessToken),
      this.ticketSeconds,
    ]);
    return { ticket, expires_in: this.ticketSeconds };
  }

  // The identity behind a ticket, consuming it, if its session is still
  // live; null otherwise (unknown, used, expired, or the session ended).
  async redeemTicket(ticket: string): Promise<StreamIdentity | null> {
    const hash = hashOpaqueToken(ticket);
    const [used] = await this.pool.execute<ResultSetHeader>(
      USE_STREAM_TICKET_SQL,
      [hash],
    );
    if (used.affectedRows !== 1) {
      return null;
    }
    const [rows] = await this.pool.execute<
      (RowDataPacket & { user_id: string; token_hash: string })[]
    >(STREAM_TICKET_SQL, [hash]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    const [live] = await this.pool.execute<RowDataPacket[]>(
      liveStreamSessionsSql(1),
      [row.token_hash],
    );
    return live[0] ? { userId: row.user_id, tokenHash: row.token_hash } : null;
  }

  // Starts the event stream on an authenticated response.
  async open(identity: StreamIdentity, response: Response): Promise<void> {
    const connection: StreamConnection = {
      id: randomUUID(),
      userId: identity.userId,
      tokenHash: identity.tokenHash,
      response,
      seen: new Set(),
    };
    // Notifications already there are in the inbox, not news.
    const [rows] = await this.pool.execute<RecentRow[]>(
      recentNotificationsSql(1),
      [identity.userId, this.lookbackSeconds],
    );
    for (const row of rows) connection.seen.add(row.id);

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transform: no proxy may compress or buffer the stream.
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    // nginx: pass each event on at once (see deploy/nginx).
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.socket?.setNoDelay(true);
    response.write(`retry: 5000\n\n`);

    const own = this.byUser.get(identity.userId) ?? [];
    own.push(connection);
    this.byUser.set(identity.userId, own);
    // The oldest connections give way: a reloaded tab must not lock itself
    // out behind its own stale connection.
    while (own.length > this.perAccount) {
      this.end(own[0], 'replaced');
    }
    response.on('close', () => this.forget(connection));

    await this.sendUnreadCount(identity.userId, [connection]);
  }

  // Sends each connection of the account its current unread count; after a
  // change on this instance (read, read-all, dismiss, dismiss-all).
  async refreshUnread(userId: string): Promise<void> {
    const own = this.byUser.get(userId);
    if (own && own.length > 0) {
      await this.sendUnreadCount(userId, own);
    }
  }

  async poll(): Promise<void> {
    const users = [...this.byUser.keys()];
    if (users.length === 0 || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const [rows] = await this.pool.execute<RecentRow[]>(
        recentNotificationsSql(users.length),
        [...users, this.lookbackSeconds],
      );
      const touched = new Set<string>();
      for (const userId of users) {
        const recent = rows.filter((row) => row.recipient_id === userId);
        const ids = new Set(recent.map((row) => row.id));
        for (const connection of this.byUser.get(userId) ?? []) {
          for (const row of recent) {
            if (!connection.seen.has(row.id)) {
              connection.seen.add(row.id);
              this.event(
                connection,
                'notification',
                toNotificationDto(row),
                row.id,
              );
              touched.add(userId);
            }
          }
          for (const id of connection.seen) {
            if (!ids.has(id)) connection.seen.delete(id);
          }
        }
      }
      for (const userId of touched) {
        await this.refreshUnread(userId);
      }
    } finally {
      this.polling = false;
    }
  }

  heartbeat(): void {
    for (const connection of this.connections()) {
      this.write(connection, ': ping\n\n');
    }
  }

  // Ends every connection (of one account, or all) whose session is no
  // longer good.
  async revalidate(userId?: string): Promise<void> {
    const connections =
      userId === undefined
        ? this.connections()
        : [...(this.byUser.get(userId) ?? [])];
    if (connections.length === 0) {
      return;
    }
    const hashes = [...new Set(connections.map((c) => c.tokenHash))];
    const [rows] = await this.pool.execute<
      (RowDataPacket & { token_hash: string; user_id: string })[]
    >(liveStreamSessionsSql(hashes.length), hashes);
    const live = new Set(rows.map((row) => `${row.user_id} ${row.token_hash}`));
    for (const connection of connections) {
      if (!live.has(`${connection.userId} ${connection.tokenHash}`)) {
        this.end(connection, 'session_ended');
      }
    }
  }

  private async sendUnreadCount(
    userId: string,
    connections: StreamConnection[],
  ): Promise<void> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { unread: number | string })[]
    >(UNREAD_COUNT_SQL, [userId, userId, userId]);
    const unread = Number(rows[0]?.unread ?? 0);
    for (const connection of connections) {
      this.event(connection, 'unread-count', { unread });
    }
  }

  private event(
    connection: StreamConnection,
    name: string,
    data: unknown,
    id?: string,
  ): void {
    this.write(
      connection,
      `${id ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  }

  // A client that went away is forgotten, never written to.
  private write(connection: StreamConnection, text: string): void {
    const { response } = connection;
    if (response.writableEnded || response.destroyed) {
      this.forget(connection);
      return;
    }
    response.write(text);
  }

  // Tells the client why, then closes: an EventSource reconnects on its own
  // after a plain close, which after session_ended only earns it a 401.
  private end(connection: StreamConnection, reason: StreamEndReason): void {
    this.forget(connection);
    this.event(connection, 'end', { reason });
    if (!connection.response.writableEnded) connection.response.end();
  }

  private forget(connection: StreamConnection): void {
    const own = this.byUser.get(connection.userId);
    if (!own) return;
    const index = own.indexOf(connection);
    if (index >= 0) own.splice(index, 1);
    if (own.length === 0) this.byUser.delete(connection.userId);
  }

  private connections(): StreamConnection[] {
    return [...this.byUser.values()].flat();
  }
}
