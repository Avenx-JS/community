import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import type {
  ReportContextType,
  ReportReason,
  ReportStatus,
} from '../reports/report.constants';
import { ListReportsDto } from './dto/list-reports.dto';

interface ReportListRow extends RowDataPacket {
  id: string;
  reporter_username: string | null;
  reported_username: string;
  reason: ReportReason;
  status: ReportStatus;
  resolution: string | null;
  context_type: ReportContextType | null;
  context_id: string | null;
  created_at: Date | string;
  reviewed_at: Date | string | null;
}

export interface AdminReportDetailRecord extends ReportListRow {
  description: string | null;
  resolution_note: string | null;
  reviewed_by_username: string | null;
  reported_user_id: string;
}

interface ReportContextRow extends RowDataPacket {
  title: string | null;
  content: string | null;
  author_username: string | null;
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
  reported_username: string;
  reason: ReportReason;
  status: ReportStatus;
  resolution: string | null;
  has_context: boolean;
  created_at: string;
  reviewed_at: string | null;
}

export interface AdminReportList {
  items: AdminReportListItem[];
  page: number;
  limit: number;
  total: number;
  filters: {
    status: ReportStatus | null;
    reason: ReportReason | null;
    reported_username: string | null;
    reporter_username: string | null;
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
  open_reports_against_user: number;
  total_reports_against_user: number;
  prior_resolutions_against_user: Array<{
    resolution: string | null;
    total: number;
  }>;
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
    reason: report.reason,
    status: report.status,
    resolution: report.resolution,
    has_context: report.context_type !== null && report.context_id !== null,
    created_at: new Date(report.created_at).toISOString(),
    reviewed_at: toIsoString(report.reviewed_at),
  };
}

export function toAdminReportDetailDto(
  report: AdminReportDetailRecord,
  context: AdminReportDetail['context'],
  counts: { open: number; total: number },
  resolutions: Array<{ resolution: string | null; total: number }>,
): AdminReportDetail {
  return {
    ...toListItem(report),
    description: report.description,
    resolution_note: report.resolution_note,
    reviewed_by_username: report.reviewed_by_username,
    context,
    open_reports_against_user: counts.open,
    total_reports_against_user: counts.total,
    prior_resolutions_against_user: resolutions,
  };
}

@Injectable()
export class AdminReportsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async findAll(query: ListReportsDto): Promise<AdminReportList> {
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
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';
    const order = query.sort === 'oldest' ? 'ASC' : 'DESC';

    const [reports] = await this.pool.execute<ReportListRow[]>(
      `SELECT ur.id, reporter_user.username AS reporter_username,
         reported_user.username AS reported_username, ur.reason, ur.status,
         ur.resolution, ur.context_type, ur.context_id, ur.created_at, ur.reviewed_at
       FROM user_reports ur
       LEFT JOIN users reporter_user ON reporter_user.id = ur.reporter_id
       INNER JOIN users reported_user ON reported_user.id = ur.reported_user_id${where}
       ORDER BY ur.created_at ${order}, ur.id ${order} LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(
      `SELECT COUNT(*) AS total
       FROM user_reports ur
       LEFT JOIN users reporter_user ON reporter_user.id = ur.reporter_id
       INNER JOIN users reported_user ON reported_user.id = ur.reported_user_id${where}`,
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
        reported_username: query.reported_username ?? null,
        reporter_username: query.reporter_username ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        sort: query.sort ?? 'new',
      },
    };
  }

  async findOne(id: string): Promise<AdminReportDetail> {
    const [reports] = await this.pool.execute<AdminReportDetailRecord[]>(
      `SELECT ur.id, reporter_user.username AS reporter_username,
         ur.reported_user_id, reported_user.username AS reported_username,
         ur.reason, ur.status, ur.resolution, ur.context_type, ur.context_id,
         ur.description, ur.resolution_note, ur.created_at, ur.reviewed_at,
         reviewer_user.username AS reviewed_by_username
       FROM user_reports ur
       LEFT JOIN users reporter_user ON reporter_user.id = ur.reporter_id
       INNER JOIN users reported_user ON reported_user.id = ur.reported_user_id
       LEFT JOIN users reviewer_user ON reviewer_user.id = ur.reviewed_by
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
