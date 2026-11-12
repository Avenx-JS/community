import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { isSqlTrue } from '../common/community-moderation';
import { readPositiveInteger } from '../common/read-positive-integer';
import { APPLY_DEFAULT_COMMUNITY_NOTIFICATIONS_SQL } from '../users/user-preferences.service';
import { CommunityBanPolicyService } from './community-ban-policy.service';
import {
  inTransaction,
  readCommunityRole,
  type CommunityRole,
} from './community-access';
import { communityMemberSql } from '../common/community-visibility';
import { CommunityModerationLogService } from './community-moderation-log.service';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';
import type { CreateJoinRequestDto } from './dto/community-join-requests.dto';
import type { ListCommunityModeratorsDto } from './dto/list-community-moderators.dto';

export type JoinRequestStatus = 'pending' | 'approved' | 'denied';

export interface JoinRequestDto {
  community: string;
  status: JoinRequestStatus;
  message: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface PendingJoinRequestDto {
  username: string;
  display_name: string | null;
  message: string | null;
  created_at: string;
}

export interface PendingJoinRequestListDto {
  items: PendingJoinRequestDto[];
  page: number;
  limit: number;
  total: number;
}

interface JoinRequestRow extends RowDataPacket {
  user_id: string;
  status: JoinRequestStatus;
  message: string | null;
  created_at: Date | string;
  decided_at: Date | string | null;
}

// The caller's request, locked, and whether a denial still blocks a new one
// (compared on the database clock, which wrote decided_at). Values: the
// retry window in hours, community id, account id.
export const LOCK_OWN_JOIN_REQUEST_SQL = `SELECT status,
         (status = 'denied' AND decided_at > CURRENT_TIMESTAMP - INTERVAL ? HOUR) AS retry_blocked
       FROM community_join_requests WHERE community_id = ? AND user_id = ? LIMIT 1 FOR UPDATE`;

// Values: community id, account id.
export const JOIN_REQUEST_SQL =
  'SELECT user_id, status, message, created_at, decided_at FROM community_join_requests WHERE community_id = ? AND user_id = ? LIMIT 1';

// A new request, or a renewed one over an earlier decision: the row is the
// account's one request to the community. Values: community, account,
// message.
export const UPSERT_JOIN_REQUEST_SQL = `INSERT INTO community_join_requests (community_id, user_id, message)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE status = 'pending', message = VALUES(message),
         created_at = CURRENT_TIMESTAMP, decided_at = NULL, decided_by = NULL`;

// Values: account (the caller), community id.
export const IS_MEMBER_SQL = `SELECT ${communityMemberSql('communities', 'viewer.id')} AS member
       FROM communities
       CROSS JOIN (SELECT CAST(? AS CHAR(36)) AS id) viewer
       WHERE communities.id = ?
       LIMIT 1`;

// The moderators' queue: pending requests, oldest first, of accounts that
// still exist. Values: community id.
export const PENDING_JOIN_REQUESTS_FROM = `FROM community_join_requests r
       JOIN users u ON u.id = r.user_id
       WHERE r.community_id = ? AND r.status = 'pending' AND u.deleted_at IS NULL`;

// The pending request of one account, by username, locked for the decision.
// Values: community id, username.
export const LOCK_PENDING_JOIN_REQUEST_SQL = `SELECT r.user_id, u.username
       FROM community_join_requests r
       JOIN users u ON u.id = r.user_id
       WHERE r.community_id = ? AND u.username = ? AND u.deleted_at IS NULL
         AND r.status = 'pending'
       LIMIT 1 FOR UPDATE OF r`;

// Values: status, decider, community id, account.
export const DECIDE_JOIN_REQUEST_SQL = `UPDATE community_join_requests
       SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
       WHERE community_id = ? AND user_id = ? AND status = 'pending'`;

export const INSERT_SUBSCRIPTION_SQL =
  'INSERT INTO community_subscriptions (user_id, community_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE created_at = created_at';

const iso = (value: Date | string) => new Date(value).toISOString();

// Joining a restricted or private community: an account asks, the creator or
// a moderator decides. Approval makes the account a member (a subscription,
// exactly as POST /subscribe writes it); both decisions are logged.
@Injectable()
export class CommunityJoinRequestsService {
  // How long a denied account waits before it may ask again.
  private readonly retryHours = readPositiveInteger(
    'COMMUNITY_JOIN_REQUEST_RETRY_HOURS',
    168,
  );
  private readonly bans: CommunityBanPolicyService;

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly ruleAcceptance: CommunityRuleAcceptanceService,
    private readonly moderationLog: CommunityModerationLogService,
    @Optional() bans?: CommunityBanPolicyService,
  ) {
    this.bans = bans ?? new CommunityBanPolicyService(pool);
  }

  // 409 for a public community (joined directly), for a member, and for a
  // request still pending or denied within the retry window; 403 when
  // banned or the rules are not accepted. Renewing after the window, or
  // after leaving an approved membership, makes the row pending again.
  async create(
    name: string,
    userId: string,
    input: CreateJoinRequestDto,
  ): Promise<JoinRequestDto> {
    return inTransaction(this.pool, async (connection) => {
      const community = await readCommunityRole(connection, name, userId);
      if (community.visibility === 'public') {
        throw new ConflictException(
          'This community is public: join it with POST /communities/:name/subscribe',
        );
      }
      await this.bans.assertNotBannedOrThrow(userId, community.id, connection);
      if (await this.isMember(connection, community.id, userId)) {
        throw new ConflictException('You are already a member');
      }
      const [existing] = await connection.execute<
        (RowDataPacket & {
          status: JoinRequestStatus;
          retry_blocked: number | string | boolean | null;
        })[]
      >(LOCK_OWN_JOIN_REQUEST_SQL, [this.retryHours, community.id, userId]);
      const previous = existing[0];
      if (previous?.status === 'pending') {
        throw new ConflictException('A join request is already pending');
      }
      if (previous && isSqlTrue(previous.retry_blocked ?? 0)) {
        throw new ConflictException(
          'Your join request was denied; you can ask again later',
        );
      }
      await this.ruleAcceptance.assertAcceptedOrThrow(
        userId,
        community.id,
        connection,
      );
      await connection.execute<ResultSetHeader>(UPSERT_JOIN_REQUEST_SQL, [
        community.id,
        userId,
        input.message ?? null,
      ]);
      const [rows] = await connection.execute<JoinRequestRow[]>(
        JOIN_REQUEST_SQL,
        [community.id, userId],
      );
      return toJoinRequestDto(community.name, rows[0]);
    });
  }

  // The caller's own request, if any: 404 otherwise.
  async findOwn(name: string, userId: string): Promise<JoinRequestDto> {
    const community = await readCommunityRole(this.pool, name, userId);
    const [rows] = await this.pool.execute<JoinRequestRow[]>(JOIN_REQUEST_SQL, [
      community.id,
      userId,
    ]);
    if (!rows[0]) {
      throw new NotFoundException('No join request');
    }
    return toJoinRequestDto(community.name, rows[0]);
  }

  async listPending(
    name: string,
    actorId: string,
    query: ListCommunityModeratorsDto,
  ): Promise<PendingJoinRequestListDto> {
    const community = await this.moderated(this.pool, name, actorId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        username: string;
        display_name: string | null;
        message: string | null;
        created_at: Date | string;
      })[]
    >(
      `SELECT u.username, u.display_name, r.message, r.created_at
       ${PENDING_JOIN_REQUESTS_FROM}
       ORDER BY r.created_at ASC, r.user_id ASC LIMIT ? OFFSET ?`,
      [community.id, limit, (page - 1) * limit],
    );
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total ${PENDING_JOIN_REQUESTS_FROM}`, [community.id]);
    return {
      items: rows.map((row) => ({
        username: row.username,
        display_name: row.display_name,
        message: row.message,
        created_at: iso(row.created_at),
      })),
      page,
      limit,
      total: Number(counts[0]?.total ?? 0),
    };
  }

  // 404 when the account has no pending request. A ban placed since the
  // request is honoured: approval is then 403, as a subscribe would be.
  async approve(name: string, username: string, actorId: string) {
    await inTransaction(this.pool, async (connection) => {
      const community = await this.moderated(connection, name, actorId, true);
      const request = await this.lockPending(connection, community, username);
      await this.bans.assertNotBannedOrThrow(
        request.user_id,
        community.id,
        connection,
      );
      await connection.execute<ResultSetHeader>(DECIDE_JOIN_REQUEST_SQL, [
        'approved',
        actorId,
        community.id,
        request.user_id,
      ]);
      await connection.execute<ResultSetHeader>(INSERT_SUBSCRIPTION_SQL, [
        request.user_id,
        community.id,
      ]);
      await connection.execute<ResultSetHeader>(
        APPLY_DEFAULT_COMMUNITY_NOTIFICATIONS_SQL,
        [request.user_id, community.id, request.user_id],
      );
      await this.moderationLog.record(connection, {
        actorId,
        communityId: community.id,
        action: 'join_request_approved',
        targetType: 'user',
        targetId: request.user_id,
        metadata: { username: request.username },
      });
    });
  }

  async deny(name: string, username: string, actorId: string) {
    await inTransaction(this.pool, async (connection) => {
      const community = await this.moderated(connection, name, actorId, true);
      const request = await this.lockPending(connection, community, username);
      await connection.execute<ResultSetHeader>(DECIDE_JOIN_REQUEST_SQL, [
        'denied',
        actorId,
        community.id,
        request.user_id,
      ]);
      await this.moderationLog.record(connection, {
        actorId,
        communityId: community.id,
        action: 'join_request_denied',
        targetType: 'user',
        targetId: request.user_id,
        metadata: { username: request.username },
      });
    });
  }

  private async moderated(
    executor: Pool | PoolConnection,
    name: string,
    actorId: string,
    forUpdate = false,
  ): Promise<CommunityRole> {
    const community = await readCommunityRole(
      executor,
      name,
      actorId,
      forUpdate,
    );
    if (!community.can_moderate) {
      throw new ForbiddenException(
        'Only the community creator and moderators can decide join requests',
      );
    }
    return community;
  }

  private async lockPending(
    connection: PoolConnection,
    community: CommunityRole,
    username: string,
  ): Promise<{ user_id: string; username: string }> {
    const [rows] = await connection.execute<
      (RowDataPacket & { user_id: string; username: string })[]
    >(LOCK_PENDING_JOIN_REQUEST_SQL, [community.id, username]);
    if (!rows[0]) {
      throw new NotFoundException('No pending join request from this user');
    }
    return rows[0];
  }

  private async isMember(
    executor: Pool | PoolConnection,
    communityId: string,
    userId: string,
  ): Promise<boolean> {
    const [rows] = await executor.execute<
      (RowDataPacket & { member: number | string | boolean })[]
    >(IS_MEMBER_SQL, [userId, communityId]);
    return rows[0] ? isSqlTrue(rows[0].member) : false;
  }
}

function toJoinRequestDto(
  community: string,
  row: JoinRequestRow,
): JoinRequestDto {
  return {
    community,
    status: row.status,
    message: row.message,
    created_at: iso(row.created_at),
    decided_at: row.decided_at === null ? null : iso(row.decided_at),
  };
}
