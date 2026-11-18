import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { ACTIVE_COMMUNITY_BAN_SQL } from '../common/active-community-ban';
import { ACTIVE_USER_RESTRICTION_PREDICATE } from '../common/active-user-restriction';
import { isSqlTrue } from '../common/community-moderation';
import { inTransaction } from '../communities/community-access';
import {
  REMOVE_MODERATOR_SQL,
  TRANSFER_CREATOR_SQL,
  TRANSFER_TARGET_MODERATOR_SQL,
} from '../communities/communities.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import {
  DELETE_MODERATOR_INVITE_SQL,
  INSERT_MODERATOR_SQL,
} from '../communities/community-moderator-invites.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AdminCommunitiesService,
  type AdminCommunityDetail,
} from './admin-communities.service';
import { ACTIVE_RESTRICTION_SQL } from './admin-roles.service';
import { AuditLogService } from './audit-log.service';

// The community row, whatever its state: a suspended community is the one
// most likely to need new people.
export const LOCK_STAFF_COMMUNITY_SQL =
  'SELECT id, name, creator_id, deleted_at FROM communities WHERE id = ? LIMIT 1 FOR UPDATE';
// Deleted accounts are found too, so a removal can clean up after one.
export const STAFF_TARGET_SQL =
  'SELECT id, username, deleted_at FROM users WHERE username = ? LIMIT 1';
// The owner being replaced, and whether a platform ban keeps them out. The
// predicate's columns are unqualified; only user_restrictions has them.
export const PREVIOUS_OWNER_SQL = `SELECT u.id, u.username, u.deleted_at,
         EXISTS (
           SELECT 1 FROM user_restrictions r
           WHERE r.user_id = u.id AND r.type = 'ban' AND ${ACTIVE_USER_RESTRICTION_PREDICATE}
         ) AS banned
       FROM users u WHERE u.id = ? LIMIT 1`;

interface CommunityRow extends RowDataPacket {
  id: string;
  name: string;
  creator_id: string;
  deleted_at: Date | string | null;
}

interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  deleted_at: Date | string | null;
}

interface PreviousOwnerRow extends UserRow {
  banned: number | string | boolean;
}

// The platform administrators' recovery tools for a community left without
// a reachable owner: reassigning the owner, and adding or removing a
// moderator without an invitation. Every community state but deleted, by
// id. Each change writes one admin_actions entry and one entry in the
// community's own moderation log, both with the administrator's reason, in
// the same transaction; the affected accounts are notified without the
// administrator's name or reason.
@Injectable()
export class AdminCommunityStaffService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly auditLog: AuditLogService,
    private readonly moderationLog: CommunityModerationLogService,
    private readonly notifications: NotificationsService,
    private readonly communities: AdminCommunitiesService,
  ) {}

  // Unlike the creator's own transfer, the new owner need not be a
  // moderator: the administrator is the authority here. They must be an
  // active account, not restricted, not banned from the community. The
  // previous owner stays on as a moderator unless deleted or banned from the
  // platform; the new owner's own moderator row and pending invitation go.
  async changeOwner(
    communityId: string,
    input: { username: string; reason: string },
    actorId: string,
  ): Promise<AdminCommunityDetail> {
    return inTransaction(this.pool, async (connection) => {
      const community = await this.lockCommunity(connection, communityId);
      const target = await this.activeTarget(connection, input.username);
      if (target.id === community.creator_id) {
        throw new ConflictException('This account already owns the community');
      }
      await this.assertEligible(connection, community, target);

      const [previousRows] = await connection.execute<PreviousOwnerRow[]>(
        PREVIOUS_OWNER_SQL,
        [community.creator_id],
      );
      const previous = previousRows[0];
      const [moved] = await connection.execute<ResultSetHeader>(
        TRANSFER_CREATOR_SQL,
        [target.id, community.id, community.creator_id],
      );
      if (moved.affectedRows !== 1) {
        throw new ConflictException('The community changed concurrently');
      }
      await connection.execute<ResultSetHeader>(REMOVE_MODERATOR_SQL, [
        community.id,
        target.id,
      ]);
      await connection.execute<ResultSetHeader>(DELETE_MODERATOR_INVITE_SQL, [
        community.id,
        target.id,
      ]);
      const previousStays =
        previous !== undefined &&
        previous.deleted_at === null &&
        !isSqlTrue(previous.banned);
      if (previousStays) {
        await connection.execute<ResultSetHeader>(INSERT_MODERATOR_SQL, [
          community.id,
          previous.id,
          actorId,
        ]);
      }

      await this.auditLog.record(connection, {
        actorId,
        action: 'community_owner_changed',
        targetType: 'community',
        targetId: community.id,
        metadata: {
          community_name: community.name,
          username: target.username,
          ...(previous ? { previous_owner_username: previous.username } : {}),
          reason: input.reason,
        },
      });
      await this.moderationLog.record(connection, {
        actorId,
        communityId: community.id,
        action: 'admin_owner_changed',
        targetType: 'user',
        targetId: target.id,
        metadata: { username: target.username, reason: input.reason },
      });
      await this.notify(
        connection,
        target.id,
        'community_ownership_assigned',
        community,
      );
      if (previous && previous.deleted_at === null) {
        await this.notify(
          connection,
          previous.id,
          'community_ownership_revoked',
          community,
        );
      }
      return this.communities.findOne(community.id, connection);
    });
  }

  // Idempotent: an existing moderator is a success that writes nothing.
  // Consumes a pending invitation of the account, now pointless.
  async addModerator(
    communityId: string,
    input: { username: string; reason: string },
    actorId: string,
  ): Promise<void> {
    await inTransaction(this.pool, async (connection) => {
      const community = await this.lockCommunity(connection, communityId);
      const target = await this.activeTarget(connection, input.username);
      if (target.id === community.creator_id) {
        throw new ConflictException('The owner already runs the community');
      }
      await this.assertEligible(connection, community, target);
      const [existing] = await connection.execute<RowDataPacket[]>(
        TRANSFER_TARGET_MODERATOR_SQL,
        [community.id, target.id],
      );
      if (existing.length > 0) {
        return;
      }
      await connection.execute<ResultSetHeader>(INSERT_MODERATOR_SQL, [
        community.id,
        target.id,
        actorId,
      ]);
      await connection.execute<ResultSetHeader>(DELETE_MODERATOR_INVITE_SQL, [
        community.id,
        target.id,
      ]);
      await this.record(connection, 'added', actorId, community, target, input);
      await this.notify(
        connection,
        target.id,
        'community_moderator_assigned',
        community,
      );
    });
  }

  // Idempotent: an account that is not a moderator is a success that writes
  // nothing. Works for a deleted account too, to clear one out. The owner is
  // refused: POST .../owner replaces them.
  async removeModerator(
    communityId: string,
    username: string,
    reason: string,
    actorId: string,
  ): Promise<void> {
    await inTransaction(this.pool, async (connection) => {
      const community = await this.lockCommunity(connection, communityId);
      const [users] = await connection.execute<UserRow[]>(STAFF_TARGET_SQL, [
        username,
      ]);
      const target = users[0];
      if (!target) {
        throw new NotFoundException('User not found');
      }
      if (target.id === community.creator_id) {
        throw new ConflictException(
          'The owner cannot be removed as a moderator; reassign the owner with POST /admin/communities/{id}/owner',
        );
      }
      const [result] = await connection.execute<ResultSetHeader>(
        REMOVE_MODERATOR_SQL,
        [community.id, target.id],
      );
      if (result.affectedRows === 0) {
        return;
      }
      await this.record(connection, 'removed', actorId, community, target, {
        reason,
      });
    });
  }

  // 404 for an unknown community, 409 for a deleted one: it has nobody to
  // serve and no route to reach it.
  private async lockCommunity(
    connection: PoolConnection,
    communityId: string,
  ): Promise<CommunityRow> {
    const [rows] = await connection.execute<CommunityRow[]>(
      LOCK_STAFF_COMMUNITY_SQL,
      [communityId],
    );
    const community = rows[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    if (community.deleted_at !== null) {
      throw new ConflictException(
        "A deleted community's owner and moderators cannot be changed",
      );
    }
    return community;
  }

  private async activeTarget(
    connection: PoolConnection,
    username: string,
  ): Promise<UserRow> {
    const [users] = await connection.execute<UserRow[]>(STAFF_TARGET_SQL, [
      username,
    ]);
    const target = users[0];
    if (!target || target.deleted_at !== null) {
      throw new NotFoundException('User not found');
    }
    return target;
  }

  private async assertEligible(
    connection: PoolConnection,
    community: CommunityRow,
    target: UserRow,
  ): Promise<void> {
    const [restrictions] = await connection.execute<RowDataPacket[]>(
      ACTIVE_RESTRICTION_SQL,
      [target.id],
    );
    if (restrictions.length > 0) {
      throw new ConflictException(
        'A suspended or banned account cannot run a community',
      );
    }
    const [bans] = await connection.execute<RowDataPacket[]>(
      ACTIVE_COMMUNITY_BAN_SQL,
      [community.id, target.id],
    );
    if (bans.length > 0) {
      throw new ConflictException(
        'An account banned from the community cannot run it',
      );
    }
  }

  private async record(
    connection: PoolConnection,
    change: 'added' | 'removed',
    actorId: string,
    community: CommunityRow,
    target: UserRow,
    input: { reason: string },
  ): Promise<void> {
    await this.auditLog.record(connection, {
      actorId,
      action:
        change === 'added'
          ? 'community_moderator_added'
          : 'community_moderator_removed',
      targetType: 'community',
      targetId: community.id,
      metadata: {
        community_name: community.name,
        username: target.username,
        reason: input.reason,
      },
    });
    await this.moderationLog.record(connection, {
      actorId,
      communityId: community.id,
      action:
        change === 'added'
          ? 'admin_moderator_added'
          : 'admin_moderator_removed',
      targetType: 'user',
      targetId: target.id,
      // A deleted account's placeholder is not a username; the target id
      // still names it.
      metadata:
        target.deleted_at === null
          ? { username: target.username, reason: input.reason }
          : { reason: input.reason },
    });
  }

  private notify(
    connection: PoolConnection,
    recipientId: string,
    type:
      | 'community_ownership_assigned'
      | 'community_ownership_revoked'
      | 'community_moderator_assigned',
    community: CommunityRow,
  ): Promise<void> {
    return this.notifications.record(connection, {
      recipientId,
      type,
      actorId: null,
      subjectType: 'community',
      subjectId: community.id,
      communityId: community.id,
      metadata: { community_name: community.name },
    });
  }
}
