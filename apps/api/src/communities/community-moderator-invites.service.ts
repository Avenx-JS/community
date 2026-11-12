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
import { visibleCommunityColumnsSql } from '../common/community-visibility';
import { CommunityBanPolicyService } from './community-ban-policy.service';
import {
  inTransaction,
  readCommunityRole,
  type CommunityRole,
} from './community-access';
import { CommunityModerationLogService } from './community-moderation-log.service';
import type { ListCommunityModeratorsDto } from './dto/list-community-moderators.dto';

export interface ModeratorInviteDto {
  community: { name: string; description: string | null };
  invited_by: string | null;
  created_at: string;
}

export interface ModeratorInviteListDto {
  items: ModeratorInviteDto[];
  page: number;
  limit: number;
  total: number;
}

// Values: username.
export const INVITEE_SQL =
  'SELECT id, username FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1';

// Values: community id, account id.
export const IS_SUBSCRIBED_SQL =
  'SELECT 1 AS subscribed FROM community_subscriptions WHERE community_id = ? AND user_id = ? LIMIT 1';
export const IS_MODERATOR_SQL =
  'SELECT 1 AS moderator FROM community_moderators WHERE community_id = ? AND user_id = ? LIMIT 1';

// Idempotent: a repeated invitation keeps the first. Values: community,
// invitee, inviter.
export const INSERT_MODERATOR_INVITE_SQL =
  'INSERT IGNORE INTO community_moderator_invites (community_id, user_id, invited_by) VALUES (?, ?, ?)';

// Values: community id, account id.
export const LOCK_MODERATOR_INVITE_SQL =
  'SELECT invited_by FROM community_moderator_invites WHERE community_id = ? AND user_id = ? LIMIT 1 FOR UPDATE';
export const DELETE_MODERATOR_INVITE_SQL =
  'DELETE FROM community_moderator_invites WHERE community_id = ? AND user_id = ?';

// Values: community, account, assigned by.
export const INSERT_MODERATOR_SQL =
  'INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id';

// The caller's invitations, newest first, to communities still there.
// Values: the caller.
export const OWN_MODERATOR_INVITES_FROM = `FROM community_moderator_invites i
       JOIN communities c ON c.id = i.community_id
       LEFT JOIN users inviter ON inviter.id = i.invited_by AND inviter.deleted_at IS NULL
       WHERE i.user_id = ? AND ${visibleCommunityColumnsSql('c')}`;

// Moderation is a role someone agrees to: the creator invites a member, the
// member accepts (becoming a moderator) or declines, and the creator may
// revoke a pending invitation. Every step is in the moderation log.
@Injectable()
export class CommunityModeratorInvitesService {
  private readonly bans: CommunityBanPolicyService;

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly moderationLog: CommunityModerationLogService,
    @Optional() bans?: CommunityBanPolicyService,
  ) {
    this.bans = bans ?? new CommunityBanPolicyService(pool);
  }

  // Creator only. The invitee must be a subscribed member, not banned, and
  // not already a moderator or the creator (409). Idempotent: a repeat is a
  // success and logs nothing new.
  async invite(name: string, username: string, actorId: string) {
    await inTransaction(this.pool, async (connection) => {
      const community = await this.asCreator(connection, name, actorId);
      const invitee = await this.invitee(connection, username);
      if (invitee.id === community.creator_id) {
        throw new ConflictException('The creator already runs the community');
      }
      if (await this.exists(connection, IS_MODERATOR_SQL, community, invitee)) {
        throw new ConflictException('This user is already a moderator');
      }
      if (
        !(await this.exists(connection, IS_SUBSCRIBED_SQL, community, invitee))
      ) {
        throw new ForbiddenException(
          'Only a subscribed community member can be invited to moderate',
        );
      }
      await this.bans.assertNotBannedOrThrow(
        invitee.id,
        community.id,
        connection,
      );
      const [result] = await connection.execute<ResultSetHeader>(
        INSERT_MODERATOR_INVITE_SQL,
        [community.id, invitee.id, actorId],
      );
      if (result.affectedRows > 0) {
        await this.moderationLog.record(connection, {
          actorId,
          communityId: community.id,
          action: 'moderator_invited',
          targetType: 'user',
          targetId: invitee.id,
          metadata: { username: invitee.username },
        });
      }
    });
  }

  // The invitee's consent. 404 without an invitation; a ban placed since
  // the invitation is honoured (403). The invitation is consumed.
  async accept(name: string, userId: string) {
    await inTransaction(this.pool, async (connection) => {
      const community = await readCommunityRole(connection, name, userId, true);
      const [invites] = await connection.execute<
        (RowDataPacket & { invited_by: string | null })[]
      >(LOCK_MODERATOR_INVITE_SQL, [community.id, userId]);
      const invite = invites[0];
      if (!invite) {
        throw new NotFoundException('No moderator invitation');
      }
      await this.bans.assertNotBannedOrThrow(userId, community.id, connection);
      await connection.execute<ResultSetHeader>(DELETE_MODERATOR_INVITE_SQL, [
        community.id,
        userId,
      ]);
      await connection.execute<ResultSetHeader>(INSERT_MODERATOR_SQL, [
        community.id,
        userId,
        invite.invited_by ?? community.creator_id,
      ]);
      const [users] = await connection.execute<
        (RowDataPacket & { username: string })[]
      >('SELECT username FROM users WHERE id = ? LIMIT 1', [userId]);
      await this.moderationLog.record(connection, {
        actorId: userId,
        communityId: community.id,
        action: 'moderator_added',
        targetType: 'user',
        targetId: userId,
        metadata: { username: users[0]?.username },
      });
    });
  }

  // With a username the creator revokes that invitation; without one the
  // caller declines their own. Idempotent: logged only when an invitation
  // was actually withdrawn.
  async withdraw(name: string, actorId: string, username?: string) {
    await inTransaction(this.pool, async (connection) => {
      let community: CommunityRole;
      let target: { id: string; username: string };
      if (username === undefined) {
        community = await readCommunityRole(connection, name, actorId, true);
        const [users] = await connection.execute<
          (RowDataPacket & { username: string })[]
        >('SELECT username FROM users WHERE id = ? LIMIT 1', [actorId]);
        target = { id: actorId, username: users[0]?.username ?? '' };
      } else {
        community = await this.asCreator(connection, name, actorId);
        target = await this.invitee(connection, username);
      }
      const [result] = await connection.execute<ResultSetHeader>(
        DELETE_MODERATOR_INVITE_SQL,
        [community.id, target.id],
      );
      if (result.affectedRows > 0) {
        await this.moderationLog.record(connection, {
          actorId,
          communityId: community.id,
          action:
            username === undefined
              ? 'moderator_invite_declined'
              : 'moderator_invite_revoked',
          targetType: 'user',
          targetId: target.id,
          metadata: target.username ? { username: target.username } : {},
        });
      }
    });
  }

  async listOwn(
    userId: string,
    query: ListCommunityModeratorsDto,
  ): Promise<ModeratorInviteListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        name: string;
        description: string | null;
        invited_by: string | null;
        created_at: Date | string;
      })[]
    >(
      `SELECT c.name, c.description, inviter.username AS invited_by, i.created_at
       ${OWN_MODERATOR_INVITES_FROM}
       ORDER BY i.created_at DESC, i.community_id DESC LIMIT ? OFFSET ?`,
      [userId, limit, (page - 1) * limit],
    );
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total ${OWN_MODERATOR_INVITES_FROM}`, [userId]);
    return {
      items: rows.map((row) => ({
        community: { name: row.name, description: row.description },
        invited_by: row.invited_by ?? null,
        created_at: new Date(row.created_at).toISOString(),
      })),
      page,
      limit,
      total: Number(counts[0]?.total ?? 0),
    };
  }

  private async asCreator(
    connection: PoolConnection,
    name: string,
    actorId: string,
  ): Promise<CommunityRole> {
    const community = await readCommunityRole(connection, name, actorId, true);
    if (community.creator_id !== actorId) {
      throw new ForbiddenException(
        'Only the community creator can manage moderator invitations',
      );
    }
    return community;
  }

  private async invitee(
    connection: PoolConnection,
    username: string,
  ): Promise<{ id: string; username: string }> {
    const [users] = await connection.execute<
      (RowDataPacket & { id: string; username: string })[]
    >(INVITEE_SQL, [username]);
    if (!users[0]) {
      throw new NotFoundException('User not found');
    }
    return users[0];
  }

  private async exists(
    connection: PoolConnection,
    sql: string,
    community: CommunityRole,
    user: { id: string },
  ): Promise<boolean> {
    const [rows] = await connection.execute<RowDataPacket[]>(sql, [
      community.id,
      user.id,
    ]);
    return rows.length > 0;
  }
}
