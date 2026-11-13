import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AuthService, MYSQL_POOL } from '../auth/auth.service';
import { RELEASE_ACCOUNT_MEDIA_SQL } from '../media/media-sql';
import { ACTIVE_ADMINS_SQL } from './users.service';

interface LockedAccountRow extends RowDataPacket {
  id: string;
  password_hash: string;
  deleted_at: Date | string | null;
}

// Neither an Argon2id nor a scrypt hash, so AuthService.verifyPassword fails
// closed for every password; auth.service.spec.ts pins that.
export const DELETED_PASSWORD_HASH = 'deleted';

// Ids are UUIDs, whose hyphens RegisterDto's username pattern rejects, and
// .invalid (RFC 2606) fails IsEmail and can never be delivered to: no one can
// register a placeholder ahead of time and block a deletion.
export const deletedUsername = (userId: string) => `deleted_${userId}`;
export const deletedEmail = (userId: string) => `deleted_${userId}@invalid`;

export const LOCK_ACCOUNT_SQL =
  'SELECT id, password_hash, deleted_at FROM users WHERE id = ? LIMIT 1 FOR UPDATE';
export const CREATED_COMMUNITY_SQL =
  'SELECT id FROM communities WHERE creator_id = ? AND deleted_at IS NULL LIMIT 1';
export const ANONYMISE_ACCOUNT_SQL =
  'UPDATE users SET username = ?, email = ?, password_hash = ?, display_name = NULL, bio = NULL, last_seen_at = NULL, deleted_at = UTC_TIMESTAMP() WHERE id = ?';
// The account's own private state, of no value to anyone else. Everything
// else that references the account (posts, comments, votes, reports,
// restrictions, rule acceptances, moderator rows) is kept.
export const DELETE_PRIVATE_STATE_SQL = [
  'DELETE FROM community_subscriptions WHERE user_id = ?',
  'DELETE FROM community_notification_preferences WHERE user_id = ?',
  'DELETE FROM notifications WHERE recipient_id = ?',
  // Bookmarks are private: no one else has a use for them.
  'DELETE FROM saved_posts WHERE user_id = ?',
  // Blocks in both directions: a deleted account can no longer interact, and
  // anonymising the row would not fire the foreign keys' cascades.
  'DELETE FROM user_blocks WHERE blocker_id = ?',
  'DELETE FROM user_blocks WHERE blocked_id = ?',
  // Anonymising would not fire the cascade, and a live link must not outlive
  // the account.
  'DELETE FROM password_reset_tokens WHERE user_id = ?',
  // Not a deletion: the reports stay, unassigned. Anonymising would not fire
  // fk_user_reports_assigned_to, and a deleted account cannot work a report.
  'UPDATE user_reports SET assigned_to = NULL, assigned_at = NULL WHERE assigned_to = ?',
  // Account settings (migration 037): codes, a pending address change,
  // preferences and exports. An export holds a copy of the account's data,
  // which must not outlive it.
  'DELETE FROM email_verification_tokens WHERE user_id = ?',
  'DELETE FROM email_changes WHERE user_id = ?',
  'DELETE FROM user_preferences WHERE user_id = ?',
  'DELETE FROM data_exports WHERE user_id = ?',
  // Community settings (migration 038): the account's join requests,
  // moderator invitations, user flairs and mutes. Anonymising would not fire
  // their cascades, and a deleted account can neither join nor moderate.
  'DELETE FROM community_join_requests WHERE user_id = ?',
  'DELETE FROM community_moderator_invites WHERE user_id = ?',
  'DELETE FROM community_user_flairs WHERE user_id = ?',
  'DELETE FROM community_mutes WHERE user_id = ?',
  // The reader's own view (migration 039): hidden posts and saved
  // comments, private like saved posts.
  'DELETE FROM hidden_posts WHERE user_id = ?',
  'DELETE FROM saved_comments WHERE user_id = ?',
  // Live notifications (migration 040): no push may reach a deleted
  // account's browsers.
  'DELETE FROM push_subscriptions WHERE user_id = ?',
  'DELETE FROM notification_stream_tickets WHERE user_id = ?',
  // The avatar and uploads never posted are released (migration 035); the
  // sweep deletes them. Files in the account's posts stay with the posts.
  ...RELEASE_ACCOUNT_MEDIA_SQL,
] as const;

export const LAST_ADMIN_MESSAGE =
  'You are the last platform administrator. Make another account an administrator before deleting yours.';

export const COMMUNITY_CREATOR_MESSAGE =
  'You created a community. Delete it or transfer its ownership before deleting your account.';

@Injectable()
export class AccountDeletionService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly authService: AuthService,
  ) {}

  // Anonymises the caller's account in place; see "Deleting your own account"
  // in README.md. Every step runs on one connection in one transaction, so a
  // failure anywhere leaves the account fully intact.
  async deleteOwnAccount(userId: string, password: string): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;

      // The lock serialises with a concurrent deletion and with any insert
      // that references the row, such as creating a community.
      const [accounts] = await connection.execute<LockedAccountRow[]>(
        LOCK_ACCOUNT_SQL,
        [userId],
      );
      const account = accounts[0];
      // Reachable only by a concurrent duplicate request: the first one
      // revokes the token this one was authenticated with.
      if (!account || account.deleted_at !== null) {
        throw new NotFoundException('User not found');
      }

      if (
        !(await this.authService.passwordMatches(
          password,
          account.password_hash,
        ))
      ) {
        throw new UnauthorizedException('Invalid credentials');
      }

      // Deleting the community or leaving it with an unreachable owner are
      // both worse than asking the creator to deal with it first.
      const [communities] = await connection.execute<RowDataPacket[]>(
        CREATED_COMMUNITY_SQL,
        [userId],
      );
      if (communities.length > 0) {
        throw new ConflictException(COMMUNITY_CREATOR_MESSAGE);
      }

      // The platform must keep an administrator: the last one cannot leave,
      // as it cannot be demoted (POST/DELETE /admin/users/:id/roles).
      const [admins] =
        await connection.execute<(RowDataPacket & { id: string })[]>(
          ACTIVE_ADMINS_SQL,
        );
      if (admins.length === 1 && admins[0].id === userId) {
        throw new ConflictException(LAST_ADMIN_MESSAGE);
      }

      await connection.execute<ResultSetHeader>(ANONYMISE_ACCOUNT_SQL, [
        deletedUsername(userId),
        deletedEmail(userId),
        DELETED_PASSWORD_HASH,
        userId,
      ]);
      for (const sql of DELETE_PRIVATE_STATE_SQL) {
        await connection.execute<ResultSetHeader>(sql, [userId]);
      }
      // Unlike a restriction, revoked after commit because AuthGuard re-checks
      // the restriction on every request, nothing on the request path checks
      // deleted_at: revocation is the enforcement here, so it commits or
      // rolls back with the deletion.
      await this.authService.revokeAllSessions(userId, connection);

      await connection.commit();
      transactionStarted = false;
      // Its live notification streams end now (sessions are gone).
      this.authService.announceSessionsChanged(userId);
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
