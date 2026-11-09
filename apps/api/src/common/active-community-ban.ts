// The one definition of "this community ban is in force", over
// community_bans' own columns: not lifted, and permanent or not yet expired.
// The ban routes and the enforcement that will refuse participation share it,
// so the two can never disagree about who is banned. Its shape matches
// ACTIVE_USER_RESTRICTION_PREDICATE on purpose, but it is a separate constant:
// a community ban and a platform restriction are different records, and
// neither may change because the other did. Columns are unqualified; only
// community_bans has them, so they stay unambiguous next to users joins.
export const ACTIVE_COMMUNITY_BAN_PREDICATE =
  'lifted_at IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())';

// "Is this account banned from this community now", bound to (community_id,
// user_id). Served by idx_community_bans_active; enforcement reads it on every
// participation attempt.
export const ACTIVE_COMMUNITY_BAN_SQL = `SELECT id FROM community_bans
       WHERE community_id = ? AND user_id = ? AND ${ACTIVE_COMMUNITY_BAN_PREDICATE}
       LIMIT 1`;
