import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';

// The community level of a report (migration 036): reports about posts and
// comments are routed to the content's community, where its moderators and
// creator review them, independently of the administrators' review
// (user_reports.status). Defined once; the queue, the report routes, content
// removal and report creation all use these.

export const COMMUNITY_REPORT_STATUSES = [
  'open',
  'approved',
  'removed',
] as const;
export type CommunityReportStatus = (typeof COMMUNITY_REPORT_STATUSES)[number];
export type CommunityReportTarget = 'post' | 'comment';

// A report in a community's queue: routed there, not yet decided by a
// moderator, and not withdrawn by its reporter. Unqualified columns; every
// statement using it reads user_reports alone or aliases nothing else with
// these names.
export const OPEN_COMMUNITY_REPORT_SQL =
  "community_status = 'open' AND withdrawn_at IS NULL";

// Closes every open community-level report of one piece of content, the
// whole queue entry at once: a decision is about the content, not about one
// report of it. Served by idx_user_reports_modqueue. Bound to [status, actor,
// community, target type, target id].
export const CLOSE_COMMUNITY_REPORTS_SQL = `UPDATE user_reports
       SET community_status = ?, community_reviewed_by = ?, community_reviewed_at = UTC_TIMESTAMP()
       WHERE community_id = ? AND target_type = ? AND target_id = ?
         AND ${OPEN_COMMUNITY_REPORT_SQL}`;

// Closes the queue entry of a piece of content on the caller's connection and
// records the decision in the community's moderation log, in the caller's
// transaction. Writes nothing when no report was open. Returns the number of
// reports closed.
export async function closeCommunityReports(
  connection: PoolConnection,
  moderationLog: Pick<CommunityModerationLogService, 'record'>,
  decision: {
    status: Exclude<CommunityReportStatus, 'open'>;
    actorId: string;
    communityId: string;
    targetType: CommunityReportTarget;
    targetId: string;
  },
): Promise<number> {
  const [result] = await connection.execute<ResultSetHeader>(
    CLOSE_COMMUNITY_REPORTS_SQL,
    [
      decision.status,
      decision.actorId,
      decision.communityId,
      decision.targetType,
      decision.targetId,
    ],
  );
  if (result.affectedRows > 0) {
    await moderationLog.record(connection, {
      actorId: decision.actorId,
      communityId: decision.communityId,
      action:
        decision.status === 'approved' ? 'report_approved' : 'report_removed',
      targetType: decision.targetType,
      targetId: decision.targetId,
      metadata: { reports: result.affectedRows },
    });
  }
  return result.affectedRows;
}
