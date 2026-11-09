import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { ACTIVE_COMMUNITY_BAN_STATE_SQL } from '../common/active-community-ban';

// Enforcement of community bans, defined once beside CommunityBansService. A
// ban excludes participation in one community: subscribing, posting,
// commenting, voting and editing. It never touches reading, reporting,
// leaving, deleting one's own content, rule acceptance, another community, or
// anything platform-wide; see "Community bans and member removal" in
// README.md for every path and its reason.

export const COMMUNITY_BANNED_REASON = 'community_banned';

// What a banned user is told, in the shape AuthGuard gives a restricted
// account: that they are banned, where, and until when for a temporary ban.
// Never the moderator's reason, the moderator, or the ban id: those are
// moderator-facing (see "Data classification" in README.md).
export interface CommunityBannedPayload {
  reason: typeof COMMUNITY_BANNED_REASON;
  community: string;
  expires_at?: string;
}

// OpenAPI text for the 403 of every gated route.
export const COMMUNITY_BANNED_FORBIDDEN_DOC =
  'Or `{ "reason": "community_banned", "community", "expires_at"? }`: the ' +
  'caller is banned from this community; `expires_at` only for a temporary ' +
  'ban. Reported before unaccepted rules.';

type Executor = Pick<Pool | PoolConnection, 'execute'>;

interface BanStateRow extends RowDataPacket {
  community_name: string;
  expires_at: Date | string | null;
}

@Injectable()
export class CommunityBanPolicyService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // Pass the transaction's connection from inside a transaction, as with
  // CommunityRuleAcceptanceService.assertAcceptedOrThrow. Call it after the
  // resource 404s and before the rule gate. No bypass for moderators or the
  // creator: an active ban on one should be impossible, and if it ever
  // exists the ban wins. Never cached: a cached answer would let a banned
  // user participate for its lifetime. A temporary ban lapses by the
  // predicate's comparison with UTC_TIMESTAMP(); no job clears it.
  async assertNotBannedOrThrow(
    userId: string,
    communityId: string,
    executor: Executor = this.pool,
  ): Promise<void> {
    const [rows] = await executor.execute<BanStateRow[]>(
      ACTIVE_COMMUNITY_BAN_STATE_SQL,
      [communityId, userId],
    );
    const ban = rows[0];
    if (!ban) {
      return;
    }
    const payload: CommunityBannedPayload = {
      reason: COMMUNITY_BANNED_REASON,
      community: ban.community_name,
      ...(ban.expires_at === null
        ? {}
        : { expires_at: new Date(ban.expires_at).toISOString() }),
    };
    throw new ForbiddenException(payload);
  }
}
