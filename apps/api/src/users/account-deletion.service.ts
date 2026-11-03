import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { AuthService, MYSQL_POOL } from '../auth/auth.service';

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
] as const;

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
