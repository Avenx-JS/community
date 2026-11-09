import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { ACTIVE_COMMUNITY_BAN_PREDICATE } from '../common/active-community-ban';
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import { CommunityModerationLogService } from './community-moderation-log.service';
import type {
  CreateCommunityBanDto,
  LiftCommunityBanDto,
  ListCommunityBansDto,
} from './dto/community-ban.dto';

// A community ban excludes one account from one community, on the decision of
// that community's creator or moderators. It is not a platform restriction:
// nothing here reads or writes user_restrictions, and a ban in one community
// touches no other. Platform role is irrelevant either way: an administrator
// can be banned from a community, and gains no right to moderate one.
//
// Nothing enforces a ban yet. These routes record decisions; the enforcement
// that refuses a banned account's participation reads
// ACTIVE_COMMUNITY_BAN_SQL and must ship with them.

export interface CommunityBanDto {
  id: string;
  // Null once the banned account was deleted (anonymised).
  username: string | null;
  reason: string;
  created_by_username: string | null;
  created_at: string;
  // Null for a permanent ban.
  expires_at: string | null;
  lifted_at: string | null;
  lifted_by_username: string | null;
  lift_reason: string | null;
  // In force now, by ACTIVE_COMMUNITY_BAN_PREDICATE: not lifted, not expired.
  active: boolean;
}

export interface CommunityBanList {
  items: CommunityBanDto[];
  page: number;
  limit: number;
  total: number;
}

interface CommunityBanRow extends RowDataPacket {
  id: string;
  username: string | null;
  reason: string;
  created_by_username: string | null;
  created_at: Date | string;
  expires_at: Date | string | null;
  lifted_at: Date | string | null;
  lifted_by_username: string | null;
  lift_reason: string | null;
  active: number | string | boolean;
}

interface CommunityAccessRow extends RowDataPacket {
  id: string;
  creator_id: string;
  can_moderate: number | string | boolean;
}

interface TargetRow extends RowDataPacket {
  id: string;
  username: string;
}

// An anonymised account is shown as null, never by its deleted_<id>
// placeholder, which contains the account id.
const visibleUsername = (alias: string) =>
  `CASE WHEN ${alias}.deleted_at IS NULL THEN ${alias}.username END`;

const BAN_FROM = `FROM community_bans
       JOIN users target ON target.id = community_bans.user_id
       LEFT JOIN users creator ON creator.id = community_bans.created_by
       LEFT JOIN users lifter ON lifter.id = community_bans.lifted_by`;

const BAN_SELECT = `SELECT community_bans.id,
         ${visibleUsername('target')} AS username,
         community_bans.reason,
         ${visibleUsername('creator')} AS created_by_username,
         community_bans.created_at, community_bans.expires_at,
         community_bans.lifted_at,
         ${visibleUsername('lifter')} AS lifted_by_username,
         community_bans.lift_reason,
         (${ACTIVE_COMMUNITY_BAN_PREDICATE}) AS active
       ${BAN_FROM}`;

// Only the creator and appointed moderators; 404 for an unknown or deleted
// community before 403, so the route does not confirm what exists to others.
export const COMMUNITY_BAN_ACCESS_SQL = `SELECT c.id, c.creator_id, ${canModerateCommunitySql('c.id')} AS can_moderate
       FROM communities c
       WHERE c.name = ? AND c.deleted_at IS NULL LIMIT 1`;

// Locks the account row: two bans of one person in one community then run one
// after the other, so the re-check below sees the first and refuses the
// second, instead of both inserting or deadlocking on gap locks.
const LOCK_TARGET_SQL =
  'SELECT id, username FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE';

const IS_MODERATOR_SQL =
  'SELECT user_id FROM community_moderators WHERE community_id = ? AND user_id = ? LIMIT 1 FOR UPDATE';

const toIso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

function toDto(row: CommunityBanRow): CommunityBanDto {
  return {
    id: row.id,
    username: row.username ?? null,
    reason: row.reason,
    created_by_username: row.created_by_username ?? null,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: toIso(row.expires_at),
    lifted_at: toIso(row.lifted_at),
    lifted_by_username: row.lifted_by_username ?? null,
    lift_reason: row.lift_reason,
    active: isSqlTrue(row.active),
  };
}

@Injectable()
export class CommunityBansService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly moderationLog: CommunityModerationLogService,
  ) {}

  // Not public: a list of excluded people is a moderation record, and
  // publishing it would invite harassment of the banned.
  async list(
    name: string,
    actorId: string,
    query: ListCommunityBansDto,
  ): Promise<CommunityBanList> {
    const community = await this.authorize(name, actorId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const state = query.active ?? 'active';
    // active and lifted partition the bans: lifted is "no longer in force",
    // whether lifted or expired.
    const stateSql =
      state === 'active'
        ? ` AND (${ACTIVE_COMMUNITY_BAN_PREDICATE})`
        : state === 'lifted'
          ? ` AND NOT (${ACTIVE_COMMUNITY_BAN_PREDICATE})`
          : '';
    const where = `WHERE community_bans.community_id = ?${stateSql}`;

    const [rows] = await this.pool.execute<CommunityBanRow[]>(
      `${BAN_SELECT}
       ${where}
       ORDER BY community_bans.created_at DESC, community_bans.id DESC
       LIMIT ? OFFSET ?`,
      [community.id, limit, offset],
    );
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total FROM community_bans ${where}`, [community.id]);

    return {
      items: rows.map(toDto),
      page,
      limit,
      total: Number(counts[0]?.total ?? 0),
    };
  }

  async ban(
    name: string,
    input: CreateCommunityBanDto,
    actorId: string,
  ): Promise<CommunityBanDto> {
    const community = await this.authorize(name, actorId);

    return this.inTransaction(async (connection) => {
      const target = await this.lockTarget(connection, input.username);
      const isModerator = await this.assertCanExclude(
        connection,
        community,
        target,
        actorId,
        'ban',
      );

      // No stacking: with two active bans "the current ban" would be
      // ambiguous. Escalating a temporary ban to a permanent one is a lift
      // and a new ban, two decisions with two records.
      const [active] = await connection.execute<RowDataPacket[]>(
        `SELECT id FROM community_bans
         WHERE community_id = ? AND user_id = ? AND ${ACTIVE_COMMUNITY_BAN_PREDICATE}
         LIMIT 1 FOR UPDATE`,
        [community.id, target.id],
      );
      if (active.length > 0) {
        throw new ConflictException(
          'User is already banned from this community',
        );
      }

      // The deadline comes from the database clock; the client only supplies
      // a bounded number of hours.
      const id = randomUUID();
      const temporary = input.duration_hours !== undefined;
      await connection.execute<ResultSetHeader>(
        `INSERT INTO community_bans
           (id, community_id, user_id, reason, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ${
           temporary ? 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR)' : 'NULL'
         })`,
        [
          id,
          community.id,
          target.id,
          input.reason,
          actorId,
          ...(temporary ? [input.duration_hours as number] : []),
        ],
      );

      // A ban is exclusion from membership. Rule acceptances are kept: an
      // unbanned member should not have to accept rules they already accepted
      // at the current version, which would be a second, silent penalty.
      await connection.execute<ResultSetHeader>(
        'DELETE FROM community_subscriptions WHERE community_id = ? AND user_id = ?',
        [community.id, target.id],
      );
      // Only the creator gets here for a moderator (assertCanExclude); the
      // role goes in the same transaction, before the ban is committed.
      if (isModerator) {
        await connection.execute<ResultSetHeader>(
          'DELETE FROM community_moderators WHERE community_id = ? AND user_id = ?',
          [community.id, target.id],
        );
      }

      const [rows] = await connection.execute<CommunityBanRow[]>(
        `${BAN_SELECT} WHERE community_bans.id = ? LIMIT 1`,
        [id],
      );
      const ban = toDto(rows[0]);
      await this.moderationLog.record(connection, {
        actorId,
        communityId: community.id,
        action: 'member_banned',
        targetType: 'user',
        targetId: target.id,
        metadata: {
          username: target.username,
          reason: input.reason,
          ...(ban.expires_at === null ? {} : { expires_at: ban.expires_at }),
        },
      });
      return ban;
    });
  }

  // Closes every open ban of the account in this community: a temporary ban
  // that expired without being lifted, and a ban imposed after it, are both
  // open. An expired ban can be lifted, which records that a moderator closed
  // it. Lifting does not restore membership: the subscription was deleted,
  // and the user rejoins through POST /communities/:name/subscribe.
  async lift(
    name: string,
    username: string,
    input: LiftCommunityBanDto,
    actorId: string,
  ): Promise<void> {
    const community = await this.authorize(name, actorId);

    await this.inTransaction(async (connection) => {
      const target = await this.lockTarget(connection, username);
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE community_bans
         SET lifted_at = UTC_TIMESTAMP(), lifted_by = ?, lift_reason = ?
         WHERE community_id = ? AND user_id = ? AND lifted_at IS NULL`,
        [actorId, input.lift_reason ?? null, community.id, target.id],
      );
      if (result.affectedRows === 0) {
        const [any] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM community_bans WHERE community_id = ? AND user_id = ? LIMIT 1',
          [community.id, target.id],
        );
        if (any.length === 0) {
          throw new NotFoundException(
            'User was never banned from this community',
          );
        }
        throw new ConflictException('Ban has already been lifted');
      }
      await this.moderationLog.record(connection, {
        actorId,
        communityId: community.id,
        action: 'member_unbanned',
        targetType: 'user',
        targetId: target.id,
        metadata: { username: target.username },
      });
    });
  }

  // Removal is not a ban: it ends the membership and the user may rejoin at
  // once. Without it a moderator's only tool would be a ban. Idempotent: a
  // non-member answers 204 and nothing is logged, since nothing happened.
  async removeMember(
    name: string,
    username: string,
    actorId: string,
  ): Promise<void> {
    const community = await this.authorize(name, actorId);

    await this.inTransaction(async (connection) => {
      const target = await this.lockTarget(connection, username);
      await this.assertCanExclude(
        connection,
        community,
        target,
        actorId,
        'remove',
      );
      const [result] = await connection.execute<ResultSetHeader>(
        'DELETE FROM community_subscriptions WHERE community_id = ? AND user_id = ?',
        [community.id, target.id],
      );
      if (result.affectedRows > 0) {
        await this.moderationLog.record(connection, {
          actorId,
          communityId: community.id,
          action: 'member_removed',
          targetType: 'user',
          targetId: target.id,
          metadata: { username: target.username },
        });
      }
    });
  }

  private async authorize(
    name: string,
    actorId: string,
  ): Promise<CommunityAccessRow> {
    const [rows] = await this.pool.execute<CommunityAccessRow[]>(
      COMMUNITY_BAN_ACCESS_SQL,
      [actorId, actorId, name],
    );
    const community = rows[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    if (!isSqlTrue(community.can_moderate)) {
      throw new ForbiddenException(
        'Only the community creator and moderators can ban or remove members',
      );
    }
    return community;
  }

  private async lockTarget(
    connection: PoolConnection,
    username: string,
  ): Promise<TargetRow> {
    const [rows] = await connection.execute<TargetRow[]>(LOCK_TARGET_SQL, [
      username,
    ]);
    if (!rows[0]) {
      throw new NotFoundException('User not found');
    }
    return rows[0];
  }

  // The authorization matrix for excluding someone, shared by ban and
  // removal. Returns whether the target moderates the community.
  private async assertCanExclude(
    connection: PoolConnection,
    community: CommunityAccessRow,
    target: TargetRow,
    actorId: string,
    kind: 'ban' | 'remove',
  ): Promise<boolean> {
    if (target.id === actorId) {
      throw new BadRequestException(
        kind === 'ban'
          ? 'You cannot ban yourself'
          : 'Use DELETE /communities/:name/subscribe to leave a community',
      );
    }
    // The owner cannot be locked out of their own community.
    if (target.id === community.creator_id) {
      throw new ForbiddenException(
        `The community creator cannot be ${kind === 'ban' ? 'banned' : 'removed'}`,
      );
    }
    const [moderators] = await connection.execute<RowDataPacket[]>(
      IS_MODERATOR_SQL,
      [community.id, target.id],
    );
    const isModerator = moderators.length > 0;
    if (!isModerator) {
      return false;
    }
    // Otherwise two moderators could exclude each other.
    if (actorId !== community.creator_id) {
      throw new ForbiddenException(
        `Only the community creator can ${kind} a moderator`,
      );
    }
    // A ban drops the role itself; removal does not, because a member who may
    // rejoin at once would come back as a moderator without a subscription.
    if (kind === 'remove') {
      throw new ConflictException(
        'Remove their moderator role first (DELETE /communities/:name/moderators)',
      );
    }
    return true;
  }

  private async inTransaction<T>(
    work: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const result = await work(connection);
      await connection.commit();
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
