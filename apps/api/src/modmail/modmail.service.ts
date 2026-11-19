import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { ACTIVE_COMMUNITY_BAN_SQL } from '../common/active-community-ban';
import { visibleCommunityColumnsSql } from '../common/community-visibility';
import { readPositiveInteger } from '../common/read-positive-integer';
import {
  inTransaction,
  readCommunityRole,
  type CommunityRole,
} from '../communities/community-access';
import { NotificationsService } from '../notifications/notifications.service';

export const MODMAIL_STATUSES = ['open', 'archived'] as const;
export type ModmailStatus = (typeof MODMAIL_STATUSES)[number];

export interface ModmailMessageDto {
  id: string;
  body: string;
  is_moderator: boolean;
  // Who wrote it: the user's username, or "moderators of c/<name>" for a
  // team reply. The moderator's own username only in author_username, and
  // only to moderators.
  author_label: string;
  author_username: string | null;
  created_at: string;
}

export interface ModmailThreadDto {
  id: string;
  community_name: string;
  subject: string;
  status: ModmailStatus;
  started_by: 'user' | 'moderators';
  // The user the team talks to; null once the account is deleted. The user's
  // own view carries it too, as their own name.
  username: string | null;
  created_at: string;
  last_message_at: string;
}

export interface ModmailThreadDetailDto extends ModmailThreadDto {
  messages: ModmailMessageDto[];
}

export interface ModmailThreadListDto {
  items: ModmailThreadDto[];
  page: number;
  limit: number;
  total: number;
}

interface ThreadRow extends RowDataPacket {
  id: string;
  community_id: string;
  community_name: string;
  user_id: string;
  username: string | null;
  subject: string;
  status: ModmailStatus;
  started_by: 'user' | 'moderators';
  created_at: Date | string;
  last_message_at: Date | string;
}

interface MessageRow extends RowDataPacket {
  id: string;
  body: string;
  is_moderator: number | boolean;
  author_username: string | null;
  created_at: Date | string;
}

const THREAD_COLUMNS = `t.id, t.community_id, c.name AS community_name, t.user_id,
         CASE WHEN u.deleted_at IS NULL THEN u.username END AS username,
         t.subject, t.status, t.started_by, t.created_at, t.last_message_at`;

const THREAD_FROM = `FROM modmail_threads t
       INNER JOIN communities c ON c.id = t.community_id
       INNER JOIN users u ON u.id = t.user_id`;

// Values: thread id.
export const THREAD_BY_ID_SQL = `SELECT ${THREAD_COLUMNS} ${THREAD_FROM} WHERE t.id = ? LIMIT 1`;
export const LOCK_THREAD_SQL = `${THREAD_BY_ID_SQL} FOR UPDATE OF t`;

// Oldest first. The author's username for moderators; mapped away for the
// user. Values: thread id.
export const THREAD_MESSAGES_SQL = `SELECT m.id, m.body, m.is_moderator, m.created_at,
         CASE WHEN a.deleted_at IS NULL THEN a.username END AS author_username
       FROM modmail_messages m
       LEFT JOIN users a ON a.id = m.author_id
       WHERE m.thread_id = ?
       ORDER BY m.created_at, m.id`;

export const INSERT_THREAD_SQL =
  'INSERT INTO modmail_threads (id, community_id, user_id, subject, started_by) VALUES (?, ?, ?, ?, ?)';
export const INSERT_MESSAGE_SQL =
  'INSERT INTO modmail_messages (id, thread_id, author_id, body, is_moderator) VALUES (?, ?, ?, ?, ?)';
// A user's message reopens an archived thread: the team has to see it.
// Values: status, thread id.
export const TOUCH_THREAD_SQL =
  'UPDATE modmail_threads SET last_message_at = UTC_TIMESTAMP(), status = ? WHERE id = ?';
export const SET_STATUS_SQL =
  'UPDATE modmail_threads SET status = ? WHERE id = ?';

// Threads the user opened with the community in the last day, under a lock
// on the user's row, so two concurrent requests cannot both pass the limit.
// Values: user (lock), user, community.
export const LOCK_USER_SQL = 'SELECT id FROM users WHERE id = ? FOR UPDATE';
export const RECENT_USER_THREADS_SQL = `SELECT COUNT(*) AS total,
         TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), MIN(created_at) + INTERVAL 1 DAY) AS retry_after
       FROM modmail_threads
       WHERE user_id = ? AND community_id = ? AND started_by = 'user'
         AND created_at > UTC_TIMESTAMP() - INTERVAL 1 DAY`;

// The team a user's message notifies: the creator and the moderators, not
// deleted, without the community muted (POST /communities/:name/mute).
// Values: community, community, community.
export const TEAM_RECIPIENTS_SQL = `SELECT u.id FROM users u
       WHERE u.deleted_at IS NULL
         AND (
           u.id = (SELECT creator_id FROM communities WHERE id = ?)
           OR EXISTS (
             SELECT 1 FROM community_moderators m
             WHERE m.community_id = ? AND m.user_id = u.id
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM community_mutes mu
           WHERE mu.user_id = u.id AND mu.community_id = ?
         )`;

// Values: username.
export const MODMAIL_USER_SQL =
  'SELECT id, username FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1';

// Whether the thread's community is still there to answer: not deleted, not
// suspended. Values: community id.
export const COMMUNITY_AVAILABLE_SQL = `SELECT 1 AS available FROM communities c WHERE c.id = ? AND ${visibleCommunityColumnsSql('c')} LIMIT 1`;

const toIso = (value: Date | string) => new Date(value).toISOString();

function toThread(row: ThreadRow): ModmailThreadDto {
  return {
    id: row.id,
    community_name: row.community_name,
    subject: row.subject,
    status: row.status,
    started_by: row.started_by,
    username: row.username ?? null,
    created_at: toIso(row.created_at),
    last_message_at: toIso(row.last_message_at),
  };
}

// Modmail: one user and the moderator team of one community. The team is the
// community's creator and moderators, every one of them a party to every
// thread of the community; the user never learns which of them replied.
// User blocks do not apply: a user cannot block the moderation team, nor the
// team a user. A community ban does not stop the user either: modmail is the
// appeal path. Every write runs in one transaction with its notifications.
@Injectable()
export class ModmailService {
  readonly threadsPerDay = readPositiveInteger('MODMAIL_THREADS_PER_DAY', 3);
  readonly bannedThreadsPerDay = readPositiveInteger(
    'MODMAIL_BANNED_THREADS_PER_DAY',
    1,
  );

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly notifications: NotificationsService,
  ) {}

  // POST /communities/:name/modmail without a username: the caller writes to
  // the team. A member of the team gets 409 (they are the team). At most
  // MODMAIL_THREADS_PER_DAY (3) new threads with one community a day, and
  // MODMAIL_BANNED_THREADS_PER_DAY (1) while banned from it; 429 beyond.
  async startAsUser(
    name: string,
    userId: string,
    input: { subject: string; body: string },
  ): Promise<ModmailThreadDetailDto> {
    return inTransaction(this.pool, async (connection) => {
      const community = await readCommunityRole(connection, name, userId);
      if (community.can_moderate) {
        throw new ConflictException(
          'You are on the moderator team of this community; start a thread with a user instead',
        );
      }
      await connection.execute(LOCK_USER_SQL, [userId]);
      const [bans] = await connection.execute<RowDataPacket[]>(
        ACTIVE_COMMUNITY_BAN_SQL,
        [community.id, userId],
      );
      const limit =
        bans.length > 0 ? this.bannedThreadsPerDay : this.threadsPerDay;
      const [recent] = await connection.execute<
        (RowDataPacket & {
          total: number | string;
          retry_after: number | string | null;
        })[]
      >(RECENT_USER_THREADS_SQL, [userId, community.id]);
      if (Number(recent[0]?.total ?? 0) >= limit) {
        const retryAfter = Math.max(1, Number(recent[0]?.retry_after ?? 1));
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `You can open ${limit} modmail thread${limit === 1 ? '' : 's'} a day with this community`,
            retry_after_seconds: retryAfter,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const threadId = await this.insertThread(
        connection,
        community,
        userId,
        input.subject,
        'user',
      );
      await this.addMessage(connection, threadId, userId, input.body, false);
      return this.readThread(connection, threadId, 'user');
    });
  }

  // POST /communities/:name/modmail with a username: the team writes to an
  // account, any account but the moderator's own (a warning, a question).
  async startAsModerator(
    name: string,
    moderatorId: string,
    input: { username: string; subject: string; body: string },
  ): Promise<ModmailThreadDetailDto> {
    return inTransaction(this.pool, async (connection) => {
      const community = await this.asModerator(connection, name, moderatorId);
      const [users] = await connection.execute<
        (RowDataPacket & { id: string; username: string })[]
      >(MODMAIL_USER_SQL, [input.username]);
      const user = users[0];
      if (!user) {
        throw new NotFoundException('User not found');
      }
      if (user.id === moderatorId) {
        throw new BadRequestException(
          'You cannot start a thread with yourself',
        );
      }
      const threadId = await this.insertThread(
        connection,
        community,
        user.id,
        input.subject,
        'moderators',
      );
      await this.addMessage(
        connection,
        threadId,
        moderatorId,
        input.body,
        true,
      );
      return this.readThread(connection, threadId, 'moderators');
    });
  }

  listOwn(
    userId: string,
    query: { page?: number; limit?: number },
  ): Promise<ModmailThreadListDto> {
    return this.list('t.user_id = ?', [userId], query);
  }

  // Open threads by default, the most recently active first.
  async listCommunity(
    name: string,
    moderatorId: string,
    query: { status?: ModmailStatus; page?: number; limit?: number },
  ): Promise<ModmailThreadListDto> {
    const community = await this.asModerator(this.pool, name, moderatorId);
    return this.list(
      't.community_id = ? AND t.status = ?',
      [community.id, query.status ?? 'open'],
      query,
    );
  }

  // The user's own thread, whatever its community's state: it is their
  // record. 404 for anyone else's.
  async getOwn(
    userId: string,
    threadId: string,
  ): Promise<ModmailThreadDetailDto> {
    const thread = await this.ownThread(this.pool, userId, threadId, false);
    return this.withMessages(this.pool, thread, 'user');
  }

  async getCommunity(
    name: string,
    moderatorId: string,
    threadId: string,
  ): Promise<ModmailThreadDetailDto> {
    const community = await this.asModerator(this.pool, name, moderatorId);
    const thread = await this.communityThread(
      this.pool,
      community,
      threadId,
      false,
    );
    return this.withMessages(this.pool, thread, 'moderators');
  }

  // Reopens an archived thread. 409 once the community is deleted or
  // suspended: nobody could read the reply.
  async replyAsUser(
    userId: string,
    threadId: string,
    body: string,
  ): Promise<ModmailThreadDetailDto> {
    return inTransaction(this.pool, async (connection) => {
      const thread = await this.ownThread(connection, userId, threadId, true);
      const [available] = await connection.execute<RowDataPacket[]>(
        COMMUNITY_AVAILABLE_SQL,
        [thread.community_id],
      );
      if (available.length === 0) {
        throw new ConflictException(
          'This community is no longer available; the thread is closed',
        );
      }
      await this.addMessage(connection, thread.id, userId, body, false);
      return this.readThread(connection, thread.id, 'user');
    });
  }

  // Keeps the thread's status: archiving is the team's decision.
  async replyAsModerator(
    name: string,
    moderatorId: string,
    threadId: string,
    body: string,
  ): Promise<ModmailThreadDetailDto> {
    return inTransaction(this.pool, async (connection) => {
      const community = await this.asModerator(connection, name, moderatorId);
      const thread = await this.communityThread(
        connection,
        community,
        threadId,
        true,
      );
      await this.addMessage(connection, thread.id, moderatorId, body, true);
      return this.readThread(connection, thread.id, 'moderators');
    });
  }

  // Idempotent: archiving an archived thread changes nothing.
  async setStatus(
    name: string,
    moderatorId: string,
    threadId: string,
    status: ModmailStatus,
  ): Promise<ModmailThreadDetailDto> {
    return inTransaction(this.pool, async (connection) => {
      const community = await this.asModerator(connection, name, moderatorId);
      const thread = await this.communityThread(
        connection,
        community,
        threadId,
        true,
      );
      if (thread.status !== status) {
        await connection.execute<ResultSetHeader>(SET_STATUS_SQL, [
          status,
          thread.id,
        ]);
      }
      return this.readThread(connection, thread.id, 'moderators');
    });
  }

  // 404 for an unknown, deleted or suspended community, then 403 unless the
  // caller created or moderates it.
  private async asModerator(
    executor: Pool | PoolConnection,
    name: string,
    actorId: string,
  ): Promise<CommunityRole> {
    const community = await readCommunityRole(executor, name, actorId);
    if (!community.can_moderate) {
      throw new ForbiddenException(
        'Only the community creator and moderators can read and answer its modmail',
      );
    }
    return community;
  }

  private async ownThread(
    executor: Pool | PoolConnection,
    userId: string,
    threadId: string,
    lock: boolean,
  ): Promise<ThreadRow> {
    const [rows] = await executor.execute<ThreadRow[]>(
      lock ? LOCK_THREAD_SQL : THREAD_BY_ID_SQL,
      [threadId],
    );
    const thread = rows[0];
    if (!thread || thread.user_id !== userId) {
      throw new NotFoundException('Modmail thread not found');
    }
    return thread;
  }

  // A thread of another community is 404, as an unknown one.
  private async communityThread(
    executor: Pool | PoolConnection,
    community: CommunityRole,
    threadId: string,
    lock: boolean,
  ): Promise<ThreadRow> {
    const [rows] = await executor.execute<ThreadRow[]>(
      lock ? LOCK_THREAD_SQL : THREAD_BY_ID_SQL,
      [threadId],
    );
    const thread = rows[0];
    if (!thread || thread.community_id !== community.id) {
      throw new NotFoundException('Modmail thread not found');
    }
    return thread;
  }

  private async insertThread(
    connection: PoolConnection,
    community: CommunityRole,
    userId: string,
    subject: string,
    startedBy: 'user' | 'moderators',
  ): Promise<string> {
    const id = randomUUID();
    await connection.execute<ResultSetHeader>(INSERT_THREAD_SQL, [
      id,
      community.id,
      userId,
      subject,
      startedBy,
    ]);
    return id;
  }

  // Writes the message, moves the thread, and notifies the other side: the
  // user for a team message, the team for the user's.
  private async addMessage(
    connection: PoolConnection,
    threadId: string,
    authorId: string,
    body: string,
    isModerator: boolean,
  ): Promise<void> {
    const id = randomUUID();
    await connection.execute<ResultSetHeader>(INSERT_MESSAGE_SQL, [
      id,
      threadId,
      authorId,
      body,
      isModerator,
    ]);
    const [rows] = await connection.execute<ThreadRow[]>(THREAD_BY_ID_SQL, [
      threadId,
    ]);
    const thread = rows[0];
    await connection.execute<ResultSetHeader>(TOUCH_THREAD_SQL, [
      isModerator ? thread.status : 'open',
      threadId,
    ]);
    const recipients = isModerator
      ? [thread.user_id]
      : (
          await connection.execute<(RowDataPacket & { id: string })[]>(
            TEAM_RECIPIENTS_SQL,
            [thread.community_id, thread.community_id, thread.community_id],
          )
        )[0].map((row) => row.id);
    const metadata = {
      community_name: thread.community_name,
      thread_id: threadId,
      thread_subject: thread.subject,
      excerpt: body,
      sender: isModerator ? ('moderators' as const) : ('user' as const),
      ...(!isModerator && thread.username
        ? { from_username: thread.username }
        : {}),
    };
    await this.notifications.recordMany(
      connection,
      recipients
        .filter((recipient) => recipient !== authorId)
        .map((recipientId) => ({
          recipientId,
          type: 'modmail_message',
          actorId: null,
          subjectType: 'modmail_message',
          subjectId: id,
          communityId: thread.community_id,
          metadata,
        })),
    );
  }

  private async readThread(
    executor: Pool | PoolConnection,
    threadId: string,
    viewer: 'user' | 'moderators',
  ): Promise<ModmailThreadDetailDto> {
    const [rows] = await executor.execute<ThreadRow[]>(THREAD_BY_ID_SQL, [
      threadId,
    ]);
    return this.withMessages(executor, rows[0], viewer);
  }

  // The one place a moderator's identity is decided: shown to moderators,
  // replaced by the team label for the user.
  private async withMessages(
    executor: Pool | PoolConnection,
    thread: ThreadRow,
    viewer: 'user' | 'moderators',
  ): Promise<ModmailThreadDetailDto> {
    const [messages] = await executor.execute<MessageRow[]>(
      THREAD_MESSAGES_SQL,
      [thread.id],
    );
    const team = `moderators of c/${thread.community_name}`;
    return {
      ...toThread(thread),
      messages: messages.map((message) => {
        const isModerator =
          message.is_moderator === true || Number(message.is_moderator) === 1;
        const username = message.author_username ?? null;
        return {
          id: message.id,
          body: message.body,
          is_moderator: isModerator,
          author_label: isModerator ? team : (username ?? 'deleted account'),
          author_username: isModerator && viewer === 'user' ? null : username,
          created_at: toIso(message.created_at),
        };
      }),
    };
  }

  private async list(
    where: string,
    values: string[],
    query: { page?: number; limit?: number },
  ): Promise<ModmailThreadListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [rows] = await this.pool.execute<ThreadRow[]>(
      `SELECT ${THREAD_COLUMNS} ${THREAD_FROM}
       WHERE ${where}
       ORDER BY t.last_message_at DESC, t.id DESC LIMIT ? OFFSET ?`,
      [...values, limit, (page - 1) * limit],
    );
    const [count] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total FROM modmail_threads t WHERE ${where}`, values);
    return {
      items: rows.map(toThread),
      page,
      limit,
      total: Number(count[0]?.total ?? 0),
    };
  }
}
