import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';

// What a block prevents, defined once. A block stops directed interaction in
// both directions (replying to the other person's content, voting on it) and
// hides the other person in the blocker's personal surfaces (the inbox, their
// profile feeds, and the blocked author's posts in the home feed). It never
// removes anyone from a shared space: community
// listings, threads and search are unfiltered, and a block is never consulted
// by reporting, posting, membership, moderation or /admin. See "Blocking
// users" in README.md for every path and its reason.

// True when either account has blocked the other. Two lookups rather than one
// EXISTS with an OR inside, so each is a direct index probe: the primary key
// (blocker_id, blocked_id) for one direction, idx_user_blocks_blocked
// (blocked_id, blocker_id) for the other. a and b are SQL expressions: a bound
// placeholder or a column.
export function eitherBlockedSql(a: string, b: string): string {
  return `(EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = ${a} AND blocked_id = ${b})
         OR EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = ${b} AND blocked_id = ${a}))`;
}

// Bound as [a, b, b, a].
export const BLOCKED_BETWEEN_SQL = `SELECT ${eitherBlockedSql('?', '?')} AS blocked`;

// True unless the viewer has blocked the author: the one direction a
// personal listing may filter by, as GET /feed does. The other direction is
// deliberately not checked: hiding the posts of someone who blocked the
// viewer would show the viewer that they were blocked. A primary-key probe of
// (blocker_id, blocked_id). viewer and author are SQL expressions.
export function notBlockedByViewerSql(viewer: string, author: string): string {
  return `NOT EXISTS (SELECT 1 FROM user_blocks WHERE user_blocks.blocker_id = ${viewer} AND user_blocks.blocked_id = ${author})`;
}

export const USER_BLOCKED_REASON = 'user_blocked';

// The 403 for a refused interaction, identical whichever way the block runs.
// It must never say who blocked whom: the blocker knows their own list, and
// telling the blocked user would make this the discoverability mechanism that
// blocks must not have. It names no user, so it reveals nothing else either.
export interface UserBlockedPayload {
  reason: typeof USER_BLOCKED_REASON;
}

// OpenAPI text for the 403 of every gated route.
export const USER_BLOCKED_FORBIDDEN_DOC =
  'Or `{ "reason": "user_blocked" }`: the caller and the author have blocked ' +
  'each other, in either direction. The body never says which.';

type Executor = Pick<Pool | PoolConnection, 'execute'>;

@Injectable()
export class UserBlockPolicyService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // Pass the transaction's connection from inside a transaction, as with
  // CommunityRuleAcceptanceService.assertAcceptedOrThrow. Never cached: a
  // cached answer would let a blocked interaction through for its lifetime.
  async isBlockedBetween(
    userId: string,
    otherUserId: string,
    executor: Executor = this.pool,
  ): Promise<boolean> {
    if (userId === otherUserId) {
      return false;
    }
    const [rows] = await executor.execute<
      (RowDataPacket & { blocked: number | string | boolean })[]
    >(BLOCKED_BETWEEN_SQL, [userId, otherUserId, otherUserId, userId]);
    const value = rows[0]?.blocked;
    return value === true || Number(value) === 1;
  }

  async assertNotBlockedOrThrow(
    actorId: string,
    otherUserId: string,
    executor: Executor = this.pool,
  ): Promise<void> {
    if (await this.isBlockedBetween(actorId, otherUserId, executor)) {
      const payload: UserBlockedPayload = { reason: USER_BLOCKED_REASON };
      throw new ForbiddenException(payload);
    }
  }
}
