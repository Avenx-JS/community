import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isSqlTrue } from './community-moderation';

// Who may read content a moderator removed (removed_at set): the content's
// community creator, a moderator of that community, and a platform
// administrator (users.role = 'admin', who reviews the report queue, where a
// report about removed content must stay readable). Everyone else, the
// content's own author included, sees a removed post as 404 and a removed
// comment as a tombstone. The one copy of the rule: every caller-dependent
// read asks canReviewRemovedContent.
// Values: community id, viewer (creator), viewer (moderator), viewer (admin).
export const REMOVED_CONTENT_REVIEWER_SQL = `SELECT (
         EXISTS (
           SELECT 1 FROM communities
           WHERE communities.id = ?
             AND (
               communities.creator_id = ? OR EXISTS (
                 SELECT 1 FROM community_moderators
                 WHERE community_moderators.community_id = communities.id
                   AND community_moderators.user_id = ?
               )
             )
         )
         OR EXISTS (SELECT 1 FROM users WHERE users.id = ? AND users.role = 'admin')
       ) AS can_review`;

export async function canReviewRemovedContent(
  executor: Pick<Pool | PoolConnection, 'execute'>,
  communityId: string,
  viewerId: string | undefined,
): Promise<boolean> {
  if (!viewerId) {
    return false;
  }
  const [rows] = await executor.execute<
    (RowDataPacket & { can_review: number | string | boolean })[]
  >(REMOVED_CONTENT_REVIEWER_SQL, [communityId, viewerId, viewerId, viewerId]);
  return rows[0] ? isSqlTrue(rows[0].can_review) : false;
}

// The moderator-facing removal state, returned only to reviewers.
export interface RemovalStateDto {
  removed: true;
  removed_at: string;
  // NULL once the removing moderator's account is deleted.
  removed_by: string | null;
  removal_reason: string | null;
}

export interface RemovalStateRow {
  removed_at?: Date | string | null;
  removed_by?: string | null;
  removal_reason?: string | null;
}

export function toRemovalState(row: RemovalStateRow): RemovalStateDto {
  return {
    removed: true,
    removed_at: new Date(row.removed_at as Date | string).toISOString(),
    removed_by: row.removed_by ?? null,
    removal_reason: row.removal_reason ?? null,
  };
}
