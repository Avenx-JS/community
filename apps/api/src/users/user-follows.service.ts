import {
  BadRequestException,
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
import { inTransaction } from '../communities/community-access';
import { loadMediaByIds } from '../media/media-dto';
import { NotificationsService } from '../notifications/notifications.service';
import { USER_ID_BY_USERNAME_SQL } from './user-activity.service';
import {
  eitherBlockedSql,
  UserBlockPolicyService,
} from './user-block-policy.service';

export interface FollowUserDto {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  followed_at: string;
}

export interface FollowListDto {
  items: FollowUserDto[];
  page: number;
  limit: number;
  total: number;
}

export interface FollowStatusDto {
  // The caller follows the user.
  following: boolean;
  // The user follows the caller.
  followed_by: boolean;
}

interface FollowRow extends RowDataPacket {
  username: string;
  display_name: string | null;
  avatar_media_id: string | null;
  followed_at: Date | string;
}

// Held as share locks in id order, as UserBlocksService.block locks its
// pair: a concurrent account deletion waits, and so does a block, which
// removes the pair's follows under the same locks.
export const LOCK_FOLLOW_PARTY_SQL =
  'SELECT username, deleted_at FROM users WHERE id = ? LIMIT 1 FOR SHARE';

// Idempotent: a repeat follow keeps the first row and its created_at.
// Values: follower, followee.
export const FOLLOW_SQL =
  'INSERT IGNORE INTO user_follows (follower_id, followee_id) VALUES (?, ?)';
export const UNFOLLOW_SQL =
  'DELETE FROM user_follows WHERE follower_id = ? AND followee_id = ?';

// Whether the followee wants new_follower notifications (default on).
// Values: followee.
export const NOTIFY_NEW_FOLLOWERS_SQL =
  'SELECT notify_new_followers FROM user_preferences WHERE user_id = ? LIMIT 1';

// Both directions between the caller and the user. Values: caller, user,
// user, caller.
export const FOLLOW_STATUS_SQL = `SELECT
         EXISTS (SELECT 1 FROM user_follows WHERE follower_id = ? AND followee_id = ?) AS following,
         EXISTS (SELECT 1 FROM user_follows WHERE follower_id = ? AND followee_id = ?) AS followed_by`;

// The two listings: the accounts on the other side of the user's follows.
// Never a deleted account (account deletion removes its rows; the filter is
// the guarantee). For a signed-in viewer, never an account blocked by or
// blocking the viewer. Newest first, by idx_user_follows_followee or
// idx_user_follows_follower_created.
const listFrom = (
  side: 'followers' | 'following',
  viewer: boolean,
) => `FROM user_follows f
       INNER JOIN users u ON u.id = f.${side === 'followers' ? 'follower_id' : 'followee_id'}
       WHERE f.${side === 'followers' ? 'followee_id' : 'follower_id'} = ?
         AND u.deleted_at IS NULL${viewer ? `\n         AND NOT ${eitherBlockedSql('u.id', '?')}` : ''}`;

// Values: user[, viewer, viewer], limit, offset.
export const followListSql = (
  side: 'followers' | 'following',
  viewer: boolean,
) => `SELECT u.username, u.display_name, u.avatar_media_id, f.created_at AS followed_at
       ${listFrom(side, viewer)}
       ORDER BY f.created_at DESC, u.id DESC
       LIMIT ? OFFSET ?`;

export const followCountSql = (
  side: 'followers' | 'following',
  viewer: boolean,
) => `SELECT COUNT(*) AS total ${listFrom(side, viewer)}`;

const isTrue = (value: unknown) => value === true || Number(value) === 1;

// Following other accounts, across every community. Following is public by
// default: the lists are readable by anyone (a hide_follow_lists preference
// is a follow-up). A follow is refused across a block in either direction,
// and a block removes the pair's follows (UserBlocksService).
@Injectable()
export class UserFollowsService {
  private readonly blocks: UserBlockPolicyService;
  private readonly notifications: NotificationsService;

  // Both optional with a fallback on the pool, as elsewhere: UsersModule
  // does not import NotificationsModule, which would close a module cycle
  // through AuthModule.
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    @Optional() blocks?: UserBlockPolicyService,
    @Optional() notifications?: NotificationsService,
  ) {
    this.blocks = blocks ?? new UserBlockPolicyService(pool);
    this.notifications = notifications ?? new NotificationsService(pool);
  }

  // 404 for an unknown or deleted account, 400 for yourself, 403 across a
  // block (the same body whichever side blocked). Idempotent. The followee
  // is notified (new_follower) on the first follow only, unless they turned
  // notify_new_followers off.
  async follow(username: string, followerId: string): Promise<void> {
    const followeeId = await this.resolve(this.pool, username);
    if (followeeId === followerId) {
      throw new BadRequestException('You cannot follow yourself');
    }
    await inTransaction(this.pool, async (connection) => {
      const names = await this.lockPair(connection, followerId, followeeId);
      await this.blocks.assertNotBlockedOrThrow(
        followerId,
        followeeId,
        connection,
      );
      const [result] = await connection.execute<ResultSetHeader>(FOLLOW_SQL, [
        followerId,
        followeeId,
      ]);
      if (result.affectedRows === 0) {
        return;
      }
      const [preferences] = await connection.execute<
        (RowDataPacket & { notify_new_followers: number | boolean })[]
      >(NOTIFY_NEW_FOLLOWERS_SQL, [followeeId]);
      if (preferences[0] && !isTrue(preferences[0].notify_new_followers)) {
        return;
      }
      await this.notifications.record(connection, {
        recipientId: followeeId,
        type: 'new_follower',
        actorId: followerId,
        subjectType: 'user',
        subjectId: followerId,
        communityId: null,
        metadata: { actor_username: names.get(followerId) },
      });
    });
  }

  // Idempotent: 204 also when not following. 404 for an unknown account.
  async unfollow(username: string, followerId: string): Promise<void> {
    const followeeId = await this.resolve(this.pool, username);
    await this.pool.execute<ResultSetHeader>(UNFOLLOW_SQL, [
      followerId,
      followeeId,
    ]);
  }

  // Public, optionally signed in: a signed-in viewer does not see accounts
  // blocked either way.
  async list(
    side: 'followers' | 'following',
    username: string,
    viewerId: string | undefined,
    query: { page?: number; limit?: number },
  ): Promise<FollowListDto> {
    const userId = await this.resolve(this.pool, username);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const viewer = viewerId !== undefined;
    const filter = viewer ? [userId, viewerId, viewerId] : [userId];
    const [rows] = await this.pool.execute<FollowRow[]>(
      followListSql(side, viewer),
      [...filter, limit, (page - 1) * limit],
    );
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(followCountSql(side, viewer), filter);
    const avatars = await loadMediaByIds(
      this.pool,
      rows.map((row) => row.avatar_media_id),
    );
    return {
      items: rows.map((row) => ({
        username: row.username,
        display_name: row.display_name,
        avatar_url:
          (row.avatar_media_id && avatars.get(row.avatar_media_id)?.url) ||
          null,
        followed_at: new Date(row.followed_at).toISOString(),
      })),
      page,
      limit,
      total: Number(counts[0]?.total ?? 0),
    };
  }

  async status(username: string, callerId: string): Promise<FollowStatusDto> {
    const userId = await this.resolve(this.pool, username);
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        following: number | boolean;
        followed_by: number | boolean;
      })[]
    >(FOLLOW_STATUS_SQL, [callerId, userId, userId, callerId]);
    return {
      following: isTrue(rows[0]?.following),
      followed_by: isTrue(rows[0]?.followed_by),
    };
  }

  private async resolve(
    executor: Pool | PoolConnection,
    username: string,
  ): Promise<string> {
    const [users] = await executor.execute<(RowDataPacket & { id: string })[]>(
      USER_ID_BY_USERNAME_SQL,
      [username],
    );
    if (!users[0]) {
      throw new NotFoundException('User not found');
    }
    return users[0].id;
  }

  // Share locks in id order; 404 if either account was deleted meanwhile.
  private async lockPair(
    connection: PoolConnection,
    a: string,
    b: string,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const id of [a, b].sort()) {
      const [rows] = await connection.execute<
        (RowDataPacket & { username: string; deleted_at: Date | null })[]
      >(LOCK_FOLLOW_PARTY_SQL, [id]);
      if (!rows[0] || rows[0].deleted_at !== null) {
        throw new NotFoundException('User not found');
      }
      names.set(id, rows[0].username);
    }
    return names;
  }
}
