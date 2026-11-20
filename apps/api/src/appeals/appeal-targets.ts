import type { AppealTargetType } from './dto/appeals.dto';

// Where each kind of appealable decision lives (migration 048). Columns are
// of the target row, aliased t:
// - owner: the affected user, the only one who may appeal;
// - actor, reason, decidedAt: who made the decision, why and when, copied
//   into appeals.original_* when the appeal is filed;
// - inForce: the decision still stands;
// - byAdmin: a platform administrator made it. A moderator's removal is
//   appealed to the community's moderators through modmail instead;
// - community: the community a moderator's removal belongs to, for the
//   pointer to its modmail.
interface AppealTargetSql {
  table: 'user_restrictions' | 'posts' | 'comments' | 'communities';
  owner: string;
  actor: string;
  reason: string;
  decidedAt: string;
  inForce: string;
  byAdmin: string;
  community: string;
}

export const APPEAL_TARGETS: Record<AppealTargetType, AppealTargetSql> = {
  // ACTIVE_USER_RESTRICTION_PREDICATE on t: an expired suspension is over.
  restriction: {
    table: 'user_restrictions',
    owner: 't.user_id',
    actor: 't.created_by',
    reason: 't.reason',
    decidedAt: 't.created_at',
    inForce:
      't.lifted_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > UTC_TIMESTAMP())',
    byAdmin: 'TRUE',
    community: 'NULL',
  },
  post_removal: {
    table: 'posts',
    owner: 't.author_id',
    actor: 't.removed_by',
    reason: 't.removal_reason',
    decidedAt: 't.removed_at',
    inForce: 't.removed_at IS NOT NULL',
    byAdmin: 't.removed_by_admin = TRUE',
    community: '(SELECT c.name FROM communities c WHERE c.id = t.community_id)',
  },
  comment_removal: {
    table: 'comments',
    owner: 't.author_id',
    actor: 't.removed_by',
    reason: 't.removal_reason',
    decidedAt: 't.removed_at',
    inForce: 't.removed_at IS NOT NULL',
    byAdmin: 't.removed_by_admin = TRUE',
    community:
      '(SELECT c.name FROM posts p JOIN communities c ON c.id = p.community_id WHERE p.id = t.post_id)',
  },
  // A deleted community is gone whatever its suspension: nothing to appeal.
  community_suspension: {
    table: 'communities',
    owner: 't.creator_id',
    actor: 't.suspended_by',
    reason: 't.suspension_reason',
    decidedAt: 't.suspended_at',
    inForce: 't.suspended_at IS NOT NULL AND t.deleted_at IS NULL',
    byAdmin: 'TRUE',
    community: 'NULL',
  },
};

// Locks the target row, so concurrent appeals of it, and an administrator
// reversing or repeating the decision, serialise with the filing. Values:
// window days, target id.
export const lockAppealTargetSql = (type: AppealTargetType) => {
  const t = APPEAL_TARGETS[type];
  return `SELECT ${t.owner} AS owner_id, (${t.inForce}) AS in_force,
         (${t.byAdmin}) AS by_admin,
         ${t.decidedAt} >= UTC_TIMESTAMP() - INTERVAL ? DAY AS in_window,
         ${t.community} AS community_name
       FROM ${t.table} t WHERE t.id = ? LIMIT 1 FOR UPDATE OF t`;
};

// An open appeal of the target, or any appeal of this very decision (the
// target's current decidedAt): what uq_appeals_open_target and
// uq_appeals_decision refuse. Values: type, target id, target id.
export const existingAppealSql = (type: AppealTargetType) => {
  const t = APPEAL_TARGETS[type];
  return `SELECT id, status FROM appeals
       WHERE target_type = ? AND target_id = ?
         AND (status = 'open'
              OR original_decided_at = (SELECT ${t.decidedAt} FROM ${t.table} t WHERE t.id = ?))
       LIMIT 1`;
};

// The decision is copied from the locked row in SQL, so original_decided_at
// is exactly the target's value and later comparisons are exact. Values: id,
// user, type, reason, target id.
export const insertAppealSql = (type: AppealTargetType) => {
  const t = APPEAL_TARGETS[type];
  return `INSERT INTO appeals
         (id, user_id, target_type, target_id, reason, original_actor_id, original_reason, original_decided_at)
       SELECT ?, ?, ?, t.id, ?, ${t.actor}, ${t.reason}, ${t.decidedAt}
       FROM ${t.table} t WHERE t.id = ?`;
};

// Locks the target row before the appeal row when an appeal is decided: the
// order filing takes, so the two cannot deadlock. Values: target id.
export const lockTargetSql = (type: AppealTargetType) =>
  `SELECT t.id FROM ${APPEAL_TARGETS[type].table} t WHERE t.id = ? LIMIT 1 FOR UPDATE`;

// Whether the appealed decision itself still stands: not reversed, and not
// replaced by a later decision on the same target (whose own appeal is a
// separate one). For a.* joined as in ADMIN_APPEAL_FROM.
export const APPEAL_IN_FORCE_SQL = `CASE a.target_type
           WHEN 'restriction' THEN COALESCE(r.lifted_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > UTC_TIMESTAMP()), FALSE)
           WHEN 'post_removal' THEN COALESCE(p.removed_by_admin = TRUE AND p.removed_at = a.original_decided_at, FALSE)
           WHEN 'comment_removal' THEN COALESCE(cm.removed_by_admin = TRUE AND cm.removed_at = a.original_decided_at, FALSE)
           ELSE COALESCE(c.deleted_at IS NULL AND c.suspended_at = a.original_decided_at, FALSE)
         END`;

// An anonymised account is null, never its deleted_<id> placeholder.
const visibleUsername = (alias: string) =>
  `CASE WHEN ${alias}.deleted_at IS NULL THEN ${alias}.username END`;

export const ADMIN_APPEAL_FROM = `FROM appeals a
       INNER JOIN users appellant ON appellant.id = a.user_id
       LEFT JOIN users decider ON decider.id = a.decided_by
       LEFT JOIN users original ON original.id = a.original_actor_id
       LEFT JOIN user_restrictions r ON a.target_type = 'restriction' AND r.id = a.target_id
       LEFT JOIN posts p ON a.target_type = 'post_removal' AND p.id = a.target_id
       LEFT JOIN comments cm ON a.target_type = 'comment_removal' AND cm.id = a.target_id
       LEFT JOIN posts cp ON cp.id = cm.post_id
       LEFT JOIN communities c ON a.target_type = 'community_suspension' AND c.id = a.target_id
       LEFT JOIN communities pc ON pc.id = COALESCE(p.community_id, cp.community_id)`;

export const ADMIN_APPEAL_COLUMNS = `a.id, a.status, a.target_type, a.target_id, a.reason,
         a.decision_note, a.created_at, a.decided_at,
         a.user_id, ${visibleUsername('appellant')} AS username,
         a.decided_by, ${visibleUsername('decider')} AS decided_by_username,
         a.original_actor_id, ${visibleUsername('original')} AS original_actor_username,
         a.original_reason, a.original_decided_at,
         r.type AS restriction_type, r.expires_at AS restriction_expires_at,
         COALESCE(p.id, cp.id) AS post_id, COALESCE(p.title, cp.title) AS post_title,
         LEFT(cm.content, 200) AS excerpt,
         COALESCE(c.id, pc.id) AS community_id, COALESCE(c.name, pc.name) AS community_name,
         ${APPEAL_IN_FORCE_SQL} AS in_force`;
