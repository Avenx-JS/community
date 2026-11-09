import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
} from '../reports/report.constants';
import type {
  ReportContextType,
  ReportReason,
  ReportStatus,
  ReportTargetType,
} from '../reports/report.constants';
import type { MetricScope } from './admin-analytics.service';
import { REPORT_TARGET_JOINS_SQL } from '../reports/report-target.sql';
import { AuditLogService } from './audit-log.service';
import type { PlatformRole } from '../users/users.service';
import { AssignReportDto } from './dto/assign-report.dto';
import { ListReportsDto } from './dto/list-reports.dto';
import type {
  ReportAssignedFilter,
  ReportWithdrawnFilter,
} from './dto/list-reports.dto';
import { UpdateReportStatusDto } from './dto/update-report-status.dto';

interface ReportListRow extends RowDataPacket {
  id: string;
  reporter_username: string | null;
  reported_username: string | null;
  target_type: ReportTargetType;
  target_id: string;
  target_label: string | null;
  reason: ReportReason;
  status: ReportStatus;
  resolution: string | null;
  context_type: ReportContextType | null;
  context_id: string | null;
  created_at: Date | string;
  reviewed_at: Date | string | null;
  withdrawn_at: Date | string | null;
  assigned_to_username: string | null;
  assigned_at: Date | string | null;
}

export interface AdminReportDetailRecord extends ReportListRow {
  description: string | null;
  resolution_note: string | null;
  reviewed_by_username: string | null;
  reported_user_id: string | null;
}

interface ReportTransitionRow extends RowDataPacket {
  id: string;
  reporter_id: string | null;
  reported_user_id: string | null;
  status: ReportStatus;
  withdrawn_at: Date | string | null;
}

interface AssignmentLockRow extends ReportTransitionRow {
  assigned_to: string | null;
}

interface AssigneeRow extends RowDataPacket {
  id: string;
  username: string;
  role: PlatformRole;
}

interface ReportContextRow extends RowDataPacket {
  title: string | null;
  content: string | null;
  author_username: string | null;
}

interface ReportTargetContentRow extends RowDataPacket {
  title: string | null;
  content: string | null;
  removed_at: Date | string | null;
}

interface ReportCountsRow extends RowDataPacket {
  open_reports_against_user: number | string;
  total_reports_against_user: number | string;
}

interface ResolutionCountRow extends RowDataPacket {
  resolution: string | null;
  total: number | string;
}

export interface AdminReportListItem {
  id: string;
  reporter_username: string | null;
  reported_username: string | null;
  target_type: ReportTargetType;
  target_id: string;
  target_label: string | null;
  reason: ReportReason;
  status: ReportStatus;
  resolution: string | null;
  has_context: boolean;
  created_at: string;
  reviewed_at: string | null;
  // Set when the reporter withdrew the report (DELETE /reports/:id).
  withdrawn_at: string | null;
  // Who owns the work, not who decided it (that is reviewed_by). Both null
  // when the report is unassigned, including after the assignee's account
  // was deleted.
  assigned_to_username: string | null;
  assigned_at: string | null;
}

export interface AdminReportList {
  items: AdminReportListItem[];
  page: number;
  limit: number;
  total: number;
  filters: {
    status: ReportStatus | null;
    reason: ReportReason | null;
    target_type: ReportTargetType | null;
    reported_username: string | null;
    reporter_username: string | null;
    withdrawn: ReportWithdrawnFilter;
    assigned: ReportAssignedFilter;
    assigned_to: string | null;
    from: string | null;
    to: string | null;
    sort: 'new' | 'oldest';
  };
}

export interface AdminReportDetail extends AdminReportListItem {
  description: string | null;
  resolution_note: string | null;
  reviewed_by_username: string | null;
  context: {
    type: ReportContextType;
    id: string;
    exists: boolean;
    title: string | null;
    content_excerpt: string | null;
    author_username: string | null;
  } | null;
  target_content: {
    title: string | null;
    content: string | null;
    removed: boolean;
  } | null;
  open_reports_against_user: number;
  total_reports_against_user: number;
  prior_resolutions_against_user: Array<{
    resolution: string | null;
    total: number;
  }>;
}

// The CASE picks the label by type over REPORT_TARGET_JOINS_SQL. Reviewers see
// the label of removed and deleted targets too; the reporter's own listing
// does not (see ReportsService).
const REPORT_TARGET_LABEL_SQL = `CASE ur.target_type
           WHEN 'user' THEN target_user.username
           WHEN 'post' THEN target_post.title
           WHEN 'comment' THEN LEFT(target_comment.content, 100)
           WHEN 'community' THEN target_community.name
         END AS target_label`;

// The platform roles AdminGuard admits on AdminReportsController, which sets
// no @RequiresRole and so gets AdminGuard's default. An assignee must be able
// to open the report they own; admin-reports.controller.spec.ts keeps the two
// in step.
export const REPORT_ASSIGNEE_ROLES: readonly PlatformRole[] = ['admin'];

/**
 * The live queue, as GET /admin/reports/stats reports it. Every figure is a
 * count of what is waiting now; history over a window (submission rates,
 * outcome mixes, review latency) is GET /admin/analytics/moderation's, and
 * must not be added here.
 */
export interface ReportQueueStats {
  open: number;
  under_review: number;
  unassigned_open: number;
  assigned_to_me_open: number;
  withdrawn_open: number;
  by_reason: Record<ReportReason, number>;
  by_target_type: Record<ReportTargetType, number>;
  oldest_open_at: string | null;
  meta: { scopes: Record<string, MetricScope> };
}

// Every figure is the queue as it stands; none takes a range.
export const REPORT_QUEUE_STATS_SCOPES: Record<
  Exclude<keyof ReportQueueStats, 'meta'>,
  MetricScope
> = {
  open: 'point_in_time',
  under_review: 'point_in_time',
  unassigned_open: 'point_in_time',
  assigned_to_me_open: 'point_in_time',
  withdrawn_open: 'point_in_time',
  by_reason: 'point_in_time',
  by_target_type: 'point_in_time',
  oldest_open_at: 'point_in_time',
};

// The queue's own default visibility (GET /admin/reports, withdrawn=exclude).
// Every figure but withdrawn_open applies it, so each one equals the total the
// queue shows for the matching filter.
const QUEUE_VISIBLE_SQL = 'withdrawn_at IS NULL';

interface KeyCountRow extends RowDataPacket {
  key: string;
  total: number | string;
}

interface CountRow extends RowDataPacket {
  total: number | string;
}

interface OldestRow extends RowDataPacket {
  created_at: Date | string;
}

function keyedCounts<K extends string>(
  keys: readonly K[],
  rows: KeyCountRow[],
): Record<K, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
    K,
    number
  >;
  for (const row of rows) {
    if (row.key in counts) {
      counts[row.key as K] = Number(row.total);
    }
  }
  return counts;
}

const countOf = (rows: CountRow[]) => Number(rows[0]?.total ?? 0);

// A report with no assignee reads as unassigned whatever assigned_at holds: a
// hard-deleted assignee leaves assigned_at behind (ON DELETE SET NULL), and an
// anonymised one is never shown by its placeholder name.
const REPORT_ASSIGNMENT_SQL = `CASE WHEN assignee_user.deleted_at IS NULL
           THEN assignee_user.username END AS assigned_to_username,
         CASE WHEN ur.assigned_to IS NULL THEN NULL ELSE ur.assigned_at END AS assigned_at`;
const REPORT_ASSIGNEE_JOIN_SQL =
  'LEFT JOIN users assignee_user ON assignee_user.id = ur.assigned_to';

// Assignment is for work still to do: a closed or withdrawn report needs no
// owner.
function assertAssignable(report: ReportTransitionRow): void {
  if (report.status === 'resolved' || report.status === 'rejected') {
    throw new ConflictException('A closed report cannot be assigned');
  }
  if (report.withdrawn_at !== null) {
    throw new ConflictException('Report was withdrawn by its reporter');
  }
}

function isPartyTo(report: ReportTransitionRow, userId: string): boolean {
  return report.reporter_id === userId || report.reported_user_id === userId;
}

function toIsoString(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toUtcSqlDate(value: string): string {
  const withUtcZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value}Z`;
  return new Date(withUtcZone).toISOString().slice(0, 19).replace('T', ' ');
}

function toListItem(report: ReportListRow): AdminReportListItem {
  return {
    id: report.id,
    reporter_username: report.reporter_username,
    reported_username: report.reported_username,
    target_type: report.target_type,
    target_id: report.target_id,
    target_label: report.target_label,
    reason: report.reason,
    status: report.status,
    resolution: report.resolution,
    has_context: report.context_type !== null && report.context_id !== null,
    created_at: new Date(report.created_at).toISOString(),
    reviewed_at: toIsoString(report.reviewed_at),
    withdrawn_at: toIsoString(report.withdrawn_at),
    assigned_to_username: report.assigned_to_username,
    assigned_at: toIsoString(report.assigned_at),
  };
}

export function toAdminReportDetailDto(
  report: AdminReportDetailRecord,
  context: AdminReportDetail['context'],
  targetContent: AdminReportDetail['target_content'],
  counts: { open: number; total: number },
  resolutions: Array<{ resolution: string | null; total: number }>,
): AdminReportDetail {
  return {
    ...toListItem(report),
    description: report.description,
    resolution_note: report.resolution_note,
    reviewed_by_username: report.reviewed_by_username,
    context,
    target_content: targetContent,
    open_reports_against_user: counts.open,
    total_reports_against_user: counts.total,
    prior_resolutions_against_user: resolutions,
  };
}

@Injectable()
export class AdminReportsService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly auditLogService: AuditLogService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async findAll(
    query: ListReportsDto,
    callerId: string,
  ): Promise<AdminReportList> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const filters: string[] = [];
    const values: (string | number)[] = [];

    if (query.status) {
      filters.push('ur.status = ?');
      values.push(query.status);
    }
    if (query.reason) {
      filters.push('ur.reason = ?');
      values.push(query.reason);
    }
    if (query.reported_username) {
      filters.push('reported_user.username = ?');
      values.push(query.reported_username);
    }
    if (query.reporter_username) {
      filters.push('reporter_user.username = ?');
      values.push(query.reporter_username);
    }
    if (query.from) {
      filters.push(
        "ur.created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
      );
      values.push(toUtcSqlDate(query.from));
    }
    if (query.to) {
      filters.push(
        "ur.created_at < CONVERT_TZ(?, '+00:00', @@session.time_zone)",
      );
      values.push(toUtcSqlDate(query.to));
    }
    if (query.target_type) {
      filters.push('ur.target_type = ?');
      values.push(query.target_type);
    }
    // A withdrawn report is one its reporter no longer stands behind, so the
    // queue leaves it out unless asked; without this a withdrawal would change
    // nothing a moderator sees.
    const withdrawn = query.withdrawn ?? 'exclude';
    if (withdrawn === 'exclude') {
      filters.push('ur.withdrawn_at IS NULL');
    } else if (withdrawn === 'only') {
      filters.push('ur.withdrawn_at IS NOT NULL');
    }
    // me compares the id, so "my reports" can use idx_user_reports_assigned.
    const assigned = query.assigned ?? 'any';
    if (assigned === 'me') {
      filters.push('ur.assigned_to = ?');
      values.push(callerId);
    } else if (assigned === 'none') {
      filters.push('ur.assigned_to IS NULL');
    }
    if (query.assigned_to) {
      filters.push('assignee_user.username = ?');
      values.push(query.assigned_to);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    const order = query.sort === 'oldest' ? 'ASC' : 'DESC';

    const [reports] = await this.pool.execute<ReportListRow[]>(
      `SELECT ur.id, reporter_user.username AS reporter_username,
         reported_user.username AS reported_username, ur.target_type, ur.target_id,
         ${REPORT_TARGET_LABEL_SQL}, ur.reason, ur.status,
         ur.resolution, ur.context_type, ur.context_id, ur.created_at, ur.reviewed_at,
         ur.withdrawn_at, ${REPORT_ASSIGNMENT_SQL}
       FROM user_reports ur
       LEFT JOIN users reporter_user ON reporter_user.id = ur.reporter_id
       LEFT JOIN users reported_user ON reported_user.id = ur.reported_user_id
       ${REPORT_ASSIGNEE_JOIN_SQL}
       ${REPORT_TARGET_JOINS_SQL}${where}
       ORDER BY ur.created_at ${order}, ur.id ${order} LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(
      `SELECT COUNT(*) AS total
       FROM user_reports ur
       LEFT JOIN users reporter_user ON reporter_user.id = ur.reporter_id
       LEFT JOIN users reported_user ON reported_user.id = ur.reported_user_id
       ${REPORT_ASSIGNEE_JOIN_SQL}${where}`,
      values,
    );

    return {
      items: reports.map(toListItem),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
      filters: {
        status: query.status ?? null,
        reason: query.reason ?? null,
        target_type: query.target_type ?? null,
        reported_username: query.reported_username ?? null,
        reporter_username: query.reporter_username ?? null,
        withdrawn,
        assigned,
        assigned_to: query.assigned_to ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        sort: query.sort ?? 'new',
      },
    };
  }

  // Small, separately indexed statements rather than one query of correlated
  // subqueries, as in AdminAnalyticsService: each can use its own index. No
  // clock or window is computed here; every figure is what the table holds.
  async queueStats(callerId: string): Promise<ReportQueueStats> {
    const [
      [statusRows],
      [reasonRows],
      [targetTypeRows],
      [unassignedRows],
      [mineRows],
      [withdrawnRows],
      [oldestRows],
    ] = await Promise.all([
      // idx_user_reports_status_created.
      this.pool.execute<KeyCountRow[]>(
        `SELECT status AS \`key\`, COUNT(*) AS total FROM user_reports
         WHERE status IN ('open', 'under_review') AND ${QUEUE_VISIBLE_SQL}
         GROUP BY status`,
        [],
      ),
      this.pool.execute<KeyCountRow[]>(
        `SELECT reason AS \`key\`, COUNT(*) AS total FROM user_reports
         WHERE status = 'open' AND ${QUEUE_VISIBLE_SQL}
         GROUP BY reason`,
        [],
      ),
      this.pool.execute<KeyCountRow[]>(
        `SELECT target_type AS \`key\`, COUNT(*) AS total FROM user_reports
         WHERE status = 'open' AND ${QUEUE_VISIBLE_SQL}
         GROUP BY target_type`,
        [],
      ),
      // idx_user_reports_assigned, for both assignment counts.
      this.pool.execute<CountRow[]>(
        `SELECT COUNT(*) AS total FROM user_reports
         WHERE assigned_to IS NULL AND status = 'open' AND ${QUEUE_VISIBLE_SQL}`,
        [],
      ),
      this.pool.execute<CountRow[]>(
        `SELECT COUNT(*) AS total FROM user_reports
         WHERE assigned_to = ? AND status = 'open' AND ${QUEUE_VISIBLE_SQL}`,
        [callerId],
      ),
      // What withdrawn=only would list. A withdrawn report always has status
      // open, and is out of every figure above.
      this.pool.execute<CountRow[]>(
        `SELECT COUNT(*) AS total FROM user_reports
         WHERE status = 'open' AND withdrawn_at IS NOT NULL`,
        [],
      ),
      // The first row in idx_user_reports_status_created order that the queue
      // shows, rather than a MIN that would read every open row.
      this.pool.execute<OldestRow[]>(
        `SELECT created_at FROM user_reports
         WHERE status = 'open' AND ${QUEUE_VISIBLE_SQL}
         ORDER BY created_at ASC LIMIT 1`,
        [],
      ),
    ]);

    const statuses = keyedCounts(['open', 'under_review'] as const, statusRows);
    return {
      open: statuses.open,
      under_review: statuses.under_review,
      unassigned_open: countOf(unassignedRows),
      assigned_to_me_open: countOf(mineRows),
      withdrawn_open: countOf(withdrawnRows),
      by_reason: keyedCounts(REPORT_REASONS, reasonRows),
      by_target_type: keyedCounts(REPORT_TARGET_TYPES, targetTypeRows),
      oldest_open_at: oldestRows[0]
        ? new Date(oldestRows[0].created_at).toISOString()
        : null,
      meta: { scopes: { ...REPORT_QUEUE_STATS_SCOPES } },
    };
  }

  async findOne(id: string): Promise<AdminReportDetail> {
    const [reports] = await this.pool.execute<AdminReportDetailRecord[]>(
      `SELECT ur.id, reporter_user.username AS reporter_username,
         ur.reported_user_id, reported_user.username AS reported_username,
         ur.target_type, ur.target_id, ${REPORT_TARGET_LABEL_SQL},
         ur.reason, ur.status, ur.resolution, ur.context_type, ur.context_id,
         ur.description, ur.resolution_note, ur.created_at, ur.reviewed_at,
         ur.withdrawn_at, reviewer_user.username AS reviewed_by_username,
         ${REPORT_ASSIGNMENT_SQL}
       FROM user_reports ur
       LEFT JOIN users reporter_user ON reporter_user.id = ur.reporter_id
       LEFT JOIN users reported_user ON reported_user.id = ur.reported_user_id
       LEFT JOIN users reviewer_user ON reviewer_user.id = ur.reviewed_by
       ${REPORT_ASSIGNEE_JOIN_SQL}
       ${REPORT_TARGET_JOINS_SQL}
       WHERE ur.id = ? LIMIT 1`,
      [id],
    );
    const report = reports[0];
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    const context = await this.loadContext(
      report.context_type,
      report.context_id,
    );
    const targetContent = await this.loadTargetContent(
      report.target_type,
      report.target_id,
    );
    // A community report concerns no account, so there is nothing to count.
    if (report.reported_user_id === null) {
      return toAdminReportDetailDto(
        report,
        context,
        targetContent,
        { open: 0, total: 0 },
        [],
      );
    }
    const [counts] = await this.pool.execute<ReportCountsRow[]>(
      `SELECT
         SUM(status IN ('open', 'under_review')) AS open_reports_against_user,
         COUNT(*) AS total_reports_against_user
       FROM user_reports
       WHERE reported_user_id = ?`,
      [report.reported_user_id],
    );
    const [resolutionCounts] = await this.pool.execute<ResolutionCountRow[]>(
      `SELECT resolution, COUNT(*) AS total
       FROM user_reports
       WHERE reported_user_id = ? AND status = 'resolved'
       GROUP BY resolution`,
      [report.reported_user_id],
    );
    const totals = counts[0];

    return toAdminReportDetailDto(
      report,
      context,
      targetContent,
      {
        open: Number(totals?.open_reports_against_user ?? 0),
        total: Number(totals?.total_reports_against_user ?? 0),
      },
      resolutionCounts.map((row) => ({
        resolution: row.resolution,
        total: Number(row.total),
      })),
    );
  }

  async updateStatus(
    id: string,
    input: UpdateReportStatusDto,
    actorId: string,
  ): Promise<AdminReportDetail> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const [reports] = await connection.execute<ReportTransitionRow[]>(
        `SELECT id, reporter_id, reported_user_id, status, withdrawn_at
         FROM user_reports
         WHERE id = ? LIMIT 1 FOR UPDATE`,
        [id],
      );
      const report = reports[0];
      if (!report) {
        throw new NotFoundException('Report not found');
      }
      if (
        report.reporter_id === actorId ||
        report.reported_user_id === actorId
      ) {
        throw new ForbiddenException(
          'Administrators cannot review their own reports',
        );
      }

      // The reporter no longer stands behind it, so there is nothing to decide.
      if (report.withdrawn_at !== null) {
        throw new ConflictException('Report was withdrawn by its reporter');
      }

      const sourceStatuses: ReportStatus[] =
        input.status === 'under_review' ? ['open'] : ['open', 'under_review'];
      if (!sourceStatuses.includes(report.status)) {
        throw new ConflictException('Report status cannot be changed');
      }

      const resolution =
        input.status === 'resolved' ? (input.resolution ?? null) : null;
      const [updateResult] = await connection.execute<ResultSetHeader>(
        `UPDATE user_reports
         SET status = ?, resolution = ?, resolution_note = ?,
             reviewed_by = ?, reviewed_at = UTC_TIMESTAMP()
         WHERE id = ? AND status IN (${sourceStatuses.map(() => '?').join(', ')})
           AND withdrawn_at IS NULL
           AND (reported_user_id IS NULL OR reported_user_id <> ?)
           AND (reporter_id IS NULL OR reporter_id <> ?)`,
        [
          input.status,
          resolution,
          input.resolution_note ?? null,
          actorId,
          id,
          ...sourceStatuses,
          actorId,
          actorId,
        ],
      );

      if (updateResult.affectedRows !== 1) {
        const [currentReports] = await connection.execute<
          ReportTransitionRow[]
        >(
          `SELECT id, reporter_id, reported_user_id, status, withdrawn_at
           FROM user_reports
           WHERE id = ? LIMIT 1`,
          [id],
        );
        const currentReport = currentReports[0];
        if (!currentReport) {
          throw new NotFoundException('Report not found');
        }
        if (
          currentReport.reporter_id === actorId ||
          currentReport.reported_user_id === actorId
        ) {
          throw new ForbiddenException(
            'Administrators cannot review their own reports',
          );
        }
        throw new ConflictException('Report status changed concurrently');
      }

      await this.auditLogService.record(connection, {
        actorId,
        action: 'report_status_changed',
        targetType: 'report',
        targetId: id,
        metadata: {
          from_status: report.status,
          to_status: input.status,
          resolution,
        },
      });
      // Only outcomes reach the reporter, and only as { status }: never the
      // resolution (it describes another person's account), the internal
      // note, or the reviewer. under_review is a queue state, not an outcome.
      // A reporter deleted since filing (reporter_id NULL) is told nothing.
      if (input.status !== 'under_review' && report.reporter_id !== null) {
        await this.notificationsService.record(connection, {
          recipientId: report.reporter_id,
          type: 'report_resolved',
          actorId: null,
          subjectType: 'report',
          subjectId: id,
          communityId: null,
          metadata: { status: input.status },
        });
      }
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

    return this.findOne(id);
  }

  // Assignment says who owns the work; it never changes status, which stays
  // entirely the decision state machine in updateStatus. Omitting the username
  // assigns the report to the caller. A repeat of the current assignment is a
  // no-op: assigned_at keeps the time the work was taken, and no entry is
  // written. A different assignee replaces the current one (a handover).
  async assign(
    id: string,
    input: AssignReportDto,
    actorId: string,
  ): Promise<AdminReportDetail> {
    await this.inTransaction(async (connection) => {
      const report = await this.lockForAssignment(connection, id, actorId);
      const assignee = await this.resolveAssignee(
        connection,
        input.username,
        actorId,
      );
      // An owner who cannot open the report would make the assignment useless.
      if (!REPORT_ASSIGNEE_ROLES.includes(assignee.role)) {
        throw new BadRequestException(
          'Reports can only be assigned to an administrator',
        );
      }
      // The same conflict-of-interest rule as updateStatus, applied to the
      // owner as well as to the caller.
      if (isPartyTo(report, assignee.id)) {
        throw new ForbiddenException(
          'A report cannot be assigned to its reporter or the reported user',
        );
      }
      assertAssignable(report);
      if (report.assigned_to === assignee.id) {
        return;
      }

      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE user_reports
         SET assigned_to = ?, assigned_at = UTC_TIMESTAMP()
         WHERE id = ? AND status IN ('open', 'under_review')
           AND withdrawn_at IS NULL`,
        [assignee.id, id],
      );
      if (result.affectedRows !== 1) {
        throw new ConflictException('Report changed concurrently');
      }
      await this.auditLogService.record(connection, {
        actorId,
        action: 'report_assigned',
        targetType: 'report',
        targetId: id,
        metadata: { assignee_username: assignee.username.slice(0, 50) },
      });
    });
    return this.findOne(id);
  }

  // Idempotent: an unassigned report answers success and writes nothing.
  async unassign(id: string, actorId: string): Promise<void> {
    await this.inTransaction(async (connection) => {
      const report = await this.lockForAssignment(connection, id, actorId);
      assertAssignable(report);
      if (report.assigned_to === null) {
        return;
      }
      const [previous] = await connection.execute<
        (RowDataPacket & { username: string })[]
      >('SELECT username FROM users WHERE id = ? LIMIT 1', [
        report.assigned_to,
      ]);

      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE user_reports SET assigned_to = NULL, assigned_at = NULL
         WHERE id = ? AND assigned_to = ?`,
        [id, report.assigned_to],
      );
      if (result.affectedRows !== 1) {
        throw new ConflictException('Report changed concurrently');
      }
      await this.auditLogService.record(connection, {
        actorId,
        action: 'report_unassigned',
        targetType: 'report',
        targetId: id,
        metadata: previous[0]
          ? { assignee_username: previous[0].username.slice(0, 50) }
          : {},
      });
    });
  }

  // Locks the report and refuses a caller who is party to it, as updateStatus
  // does: the caller must not steer the handling of their own report.
  private async lockForAssignment(
    connection: PoolConnection,
    id: string,
    actorId: string,
  ): Promise<AssignmentLockRow> {
    const [reports] = await connection.execute<AssignmentLockRow[]>(
      `SELECT id, reporter_id, reported_user_id, status, withdrawn_at, assigned_to
       FROM user_reports
       WHERE id = ? LIMIT 1 FOR UPDATE`,
      [id],
    );
    const report = reports[0];
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    if (isPartyTo(report, actorId)) {
      throw new ForbiddenException(
        'Administrators cannot handle their own reports',
      );
    }
    return report;
  }

  // An anonymised account cannot be assigned: it can no longer sign in.
  private async resolveAssignee(
    connection: PoolConnection,
    username: string | undefined,
    actorId: string,
  ): Promise<AssigneeRow> {
    const [users] = await connection.execute<AssigneeRow[]>(
      username === undefined
        ? 'SELECT id, username, role FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1'
        : 'SELECT id, username, role FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1',
      [username ?? actorId],
    );
    if (!users[0]) {
      throw new NotFoundException('User not found');
    }
    return users[0];
  }

  private async inTransaction(
    work: (connection: PoolConnection) => Promise<void>,
  ): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      await work(connection);
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

  // In full, unlike the context excerpt: this is the thing being judged. Removed
  // content stays readable here, because removal keeps the row.
  private async loadTargetContent(
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<AdminReportDetail['target_content']> {
    if (targetType !== 'post' && targetType !== 'comment') {
      return null;
    }
    const [rows] = await this.pool.execute<ReportTargetContentRow[]>(
      targetType === 'post'
        ? 'SELECT title, content, removed_at FROM posts WHERE id = ? LIMIT 1'
        : 'SELECT NULL AS title, content, removed_at FROM comments WHERE id = ? LIMIT 1',
      [targetId],
    );
    const row = rows[0];
    return row
      ? {
          title: row.title,
          content: row.content,
          removed: row.removed_at !== null,
        }
      : null;
  }

  private async loadContext(
    contextType: ReportContextType | null,
    contextId: string | null,
  ): Promise<AdminReportDetail['context']> {
    if (!contextType || !contextId) {
      return null;
    }

    const table = contextType === 'post' ? 'posts' : 'comments';
    const titleExpression =
      contextType === 'post' ? 'context.title' : 'NULL AS title';
    const [contexts] = await this.pool.execute<ReportContextRow[]>(
      `SELECT ${titleExpression}, context.content AS content,
         author.username AS author_username
       FROM ${table} context
       LEFT JOIN users author ON author.id = context.author_id
       WHERE context.id = ? LIMIT 1`,
      [contextId],
    );
    const row = contexts[0];
    if (!row) {
      return {
        type: contextType,
        id: contextId,
        exists: false,
        title: null,
        content_excerpt: null,
        author_username: null,
      };
    }

    return {
      type: contextType,
      id: contextId,
      exists: true,
      title: row.title,
      content_excerpt: row.content === null ? null : row.content.slice(0, 500),
      author_username: row.author_username,
    };
  }
}
