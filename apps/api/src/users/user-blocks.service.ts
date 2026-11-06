import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { readPositiveInteger } from '../common/read-positive-integer';
import type { ListBlockedUsersDto } from './dto/list-blocked-users.dto';
import { USER_ID_BY_USERNAME_SQL, type Page } from './user-activity.service';

export interface BlockedUserDto {
  username: string;
  display_name: string | null;
  blocked_at: string;
}

interface BlockedUserRow extends RowDataPacket {
  username: string;
  display_name: string | null;
  blocked_at: Date | string;
}

interface LockedUserRow extends RowDataPacket {
  deleted_at: Date | string | null;
}

interface BlockStateRow extends RowDataPacket {
  total: number | string;
  already_blocked: number | string;
}

// The blocker's row is locked exclusively to serialise that user's blocks for
// the cap. The blocked row needs only a share lock, to hold off a concurrent
// account deletion, so blocks of one popular account do not queue on each other.
export const LOCK_BLOCKER_SQL =
  'SELECT deleted_at FROM users WHERE id = ? LIMIT 1 FOR UPDATE';
export const LOCK_BLOCKED_SQL =
  'SELECT deleted_at FROM users WHERE id = ? LIMIT 1 FOR SHARE';

// A locking read, so it sees a block committed while this transaction waited
// for the blocker's row rather than an older snapshot. already_blocked keeps a
// repeat block idempotent at the cap: it adds no row, so it is not refused.
export const BLOCK_STATE_SQL =
  'SELECT COUNT(*) AS total, COALESCE(SUM(blocked_id = ?), 0) AS already_blocked FROM user_blocks WHERE blocker_id = ? FOR SHARE';

export const BLOCK_USER_SQL =
  'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE created_at = created_at';

export const UNBLOCK_USER_SQL =
  'DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?';

// The listing's FROM and WHERE, shared verbatim by the page and its total.
// STRAIGHT_JOIN keeps user_blocks first, so the order is
// idx_user_blocks_blocker_created's. A deleted account can no longer interact,
// so it is omitted: AccountDeletionService removes its rows and the lock in
// block() stops a new one appearing, which leaves the filter as the guarantee
// that a placeholder username is never returned.
export const BLOCKED_USERS_FROM = `FROM user_blocks b
       STRAIGHT_JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ?
         AND u.deleted_at IS NULL`;

export const BLOCKED_USERS_SQL = `SELECT u.username, u.display_name, b.created_at AS blocked_at
       ${BLOCKED_USERS_FROM}
       ORDER BY b.created_at DESC, b.blocked_id DESC
       LIMIT ? OFFSET ?`;

export const BLOCKED_USERS_COUNT_SQL = `SELECT COUNT(*) AS total ${BLOCKED_USERS_FROM}`;

// The relationship and its management only: nothing reads user_blocks to change
// behaviour yet (see "Blocking users" in README.md). Blocks are private. Every
// statement is bound to the caller's id from the token, no route takes a blocker
// parameter, and nothing here notifies the blocked user or writes an audit entry.
@Injectable()
export class UserBlocksService {
  private readonly blocksMax = readPositiveInteger('USER_BLOCKS_MAX', 1000);

  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // Idempotent: a repeat block leaves one row and keeps its created_at, the
  // listing's order key.
  async block(username: string, blockerId: string): Promise<void> {
    const blockedId = await this.resolveUserId(username);
    if (blockedId === blockerId) {
      throw new BadRequestException('You cannot block yourself');
    }

    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;

      // Always in id order. The insert's foreign-key checks take share locks on
      // both users rows, so if each request locked its own blocker first, A
      // blocking B while B blocks A would deadlock.
      const locks: [string, string][] = [
        [blockerId, LOCK_BLOCKER_SQL],
        [blockedId, LOCK_BLOCKED_SQL],
      ];
      locks.sort(([left], [right]) => (left < right ? -1 : 1));
      for (const [id, sql] of locks) {
        const [users] = await connection.execute<LockedUserRow[]>(sql, [id]);
        // Deleted since the lookup above: its rows are already gone, and a new
        // one would outlive the deletion.
        if (!users[0] || users[0].deleted_at !== null) {
          throw new NotFoundException('User not found');
        }
      }

      const [states] = await connection.execute<BlockStateRow[]>(
        BLOCK_STATE_SQL,
        [blockedId, blockerId],
      );
      const alreadyBlocked = Number(states[0]?.already_blocked ?? 0) > 0;
      if (!alreadyBlocked && Number(states[0]?.total ?? 0) >= this.blocksMax) {
        throw new ConflictException(
          `You can block at most ${this.blocksMax} accounts`,
        );
      }

      await connection.execute<ResultSetHeader>(BLOCK_USER_SQL, [
        blockerId,
        blockedId,
      ]);

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

  // Idempotent: removing a block that does not exist is still a success.
  async unblock(username: string, blockerId: string): Promise<void> {
    const blockedId = await this.resolveUserId(username);
    await this.pool.execute<ResultSetHeader>(UNBLOCK_USER_SQL, [
      blockerId,
      blockedId,
    ]);
  }

  async list(
    blockerId: string,
    query: ListBlockedUsersDto,
  ): Promise<Page<BlockedUserDto>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [rows] = await this.pool.execute<BlockedUserRow[]>(
      BLOCKED_USERS_SQL,
      [blockerId, limit, (page - 1) * limit],
    );
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(BLOCKED_USERS_COUNT_SQL, [blockerId]);

    return {
      items: rows.map((row) => ({
        username: row.username,
        display_name: row.display_name,
        blocked_at: new Date(row.blocked_at).toISOString(),
      })),
      page,
      limit,
      total: Number(counts[0]?.total ?? 0),
    };
  }

  private async resolveUserId(username: string): Promise<string> {
    const [users] = await this.pool.execute<(RowDataPacket & { id: string })[]>(
      USER_ID_BY_USERNAME_SQL,
      [username],
    );
    if (!users[0]) {
      throw new NotFoundException('User not found');
    }
    return users[0].id;
  }
}
