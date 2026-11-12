import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommentRemovalService } from '../comments/comment-removals.service';
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import { visibleCommunityColumnsSql } from '../common/community-visibility';
import type { RemoveContentDto } from '../common/remove-content.dto';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { PostsService } from '../posts/posts.service';
import {
  closeCommunityReports,
  OPEN_COMMUNITY_REPORT_SQL,
  type CommunityReportStatus,
  type CommunityReportTarget,
} from './community-report-review';
import type {
  ListCommunityReportsDto,
  ListModQueueDto,
  ModQueueSort,
} from './dto/community-reports.dto';
import type { ReportReason } from './report.constants';

// How many of an entry's reports a queue entry or report detail lists. The
// entry's counts always cover all of them.
export const ENTRY_REPORTS_SHOWN = 25;

// What moderators see of reported content. They review removed content too,
// so removed posts and comments are shown, marked; content its author has
// since deleted is null. The author's username is null once their account
// is deleted.
export interface ReportedContentDto {
  type: CommunityReportTarget;
  id: string;
  // A comment's post.
  post_id: string | null;
  // A post's title; null for a comment.
  title: string | null;
  // The first 300 characters of the body, the link or the caption.
  excerpt: string | null;
  author_username: string | null;
  created_at: string;
  removed: boolean;
}

// One report as moderators see it. Never the reporter: a moderator must not
// learn who reported whom, or the report becomes a reason for retaliation.
export interface CommunityReportItemDto {
  id: string;
  reason: ReportReason;
  description: string | null;
  created_at: string;
}

// All open reports of one post or comment, as one entry.
export interface ModQueueEntryDto {
  target_type: CommunityReportTarget;
  target_id: string;
  target: ReportedContentDto | null;
  report_count: number;
  // Distinct reporters; reports by since-deleted accounts are not counted.
  reporter_count: number;
  reasons: Partial<Record<ReportReason, number>>;
  first_reported_at: string;
  last_reported_at: string;
  // The newest ENTRY_REPORTS_SHOWN open reports.
  reports: CommunityReportItemDto[];
}

export interface CommunityReportDto extends CommunityReportItemDto {
  target_type: CommunityReportTarget;
  target_id: string;
  target: ReportedContentDto | null;
  community_status: CommunityReportStatus;
  community_reviewed_at: string | null;
  // The open reports on the same content, this one included.
  open_reports_on_target: number;
  open_reporters_on_target: number;
}

// GET /communities/:name/reports/:id: the report, the moderator who closed
// it, and the open reports on the same content.
export interface CommunityReportDetailDto extends CommunityReportDto {
  community_reviewed_by_username: string | null;
  other_open_reports: CommunityReportItemDto[];
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

interface EntryRow extends RowDataPacket {
  target_type: CommunityReportTarget;
  target_id: string;
  report_count: number | string;
  reporter_count: number | string;
  first_reported_at: Date | string;
  last_reported_at: Date | string;
}

interface ReportRow extends RowDataPacket {
  id: string;
  target_type: CommunityReportTarget;
  target_id: string;
  reason: ReportReason;
  description: string | null;
  created_at: Date | string;
  community_status: CommunityReportStatus;
  community_reviewed_at: Date | string | null;
  community_reviewed_by_username?: string | null;
}

interface ContentRow extends RowDataPacket {
  id: string;
  post_id: string | null;
  title: string | null;
  excerpt: string | null;
  author_username: string | null;
  author_deleted_at: Date | string | null;
  created_at: Date | string;
  removed_at: Date | string | null;
}

const iso = (value: Date | string) => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null | undefined) =>
  value ? iso(value) : null;

// The community a moderator acts in, with whether the caller may: 404 for
// an unknown, deleted or suspended community, as everywhere, then 403 for
// anyone but its creator and moderators (platform administrators review
// reports under /admin). Bound to [actor, actor, name].
export const MODERATED_COMMUNITY_SQL = `SELECT c.id, ${canModerateCommunitySql('c.id')} AS can_moderate
       FROM communities c
       WHERE c.name = ? AND ${visibleCommunityColumnsSql('c')}
       LIMIT 1`;

const ENTRY_ORDER: Record<ModQueueSort, string> = {
  oldest: 'first_reported_at ASC',
  newest: 'last_reported_at DESC',
  most_reported: 'report_count DESC, first_reported_at ASC',
};

// The open reports of a community, grouped by their content: one queue
// entry per post or comment. Served by idx_user_reports_modqueue
// (community_id, community_status, target_type, target_id).
export function modQueueSql(sort: ModQueueSort, byType: boolean): string {
  return `SELECT target_type, target_id, COUNT(*) AS report_count,
         COUNT(DISTINCT reporter_id) AS reporter_count,
         MIN(created_at) AS first_reported_at, MAX(created_at) AS last_reported_at
       FROM user_reports
       WHERE community_id = ? AND ${OPEN_COMMUNITY_REPORT_SQL}${byType ? ' AND target_type = ?' : ''}
       GROUP BY target_type, target_id
       ORDER BY ${ENTRY_ORDER[sort]}, target_type ASC, target_id ASC
       LIMIT ? OFFSET ?`;
}

export function modQueueCountSql(byType: boolean): string {
  return `SELECT COUNT(*) AS total FROM (
         SELECT 1 FROM user_reports
         WHERE community_id = ? AND ${OPEN_COMMUNITY_REPORT_SQL}${byType ? ' AND target_type = ?' : ''}
         GROUP BY target_type, target_id
       ) AS entries`;
}

const targetsMatch = (count: number) =>
  Array.from(
    { length: count },
    () => '(target_type = ? AND target_id = ?)',
  ).join(' OR ');

@Injectable()
export class CommunityReportsService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly moderationLog: CommunityModerationLogService,
    private readonly posts: PostsService,
    private readonly commentRemovals: CommentRemovalService,
  ) {}

  // GET /communities/:name/modqueue.
  async modQueue(
    name: string,
    actorId: string,
    query: ListModQueueDto,
  ): Promise<Page<ModQueueEntryDto>> {
    const communityId = await this.authorize(this.pool, name, actorId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sort = query.sort ?? 'oldest';
    const filter = query.target_type ? [query.target_type] : [];
    const [entries] = await this.pool.execute<EntryRow[]>(
      modQueueSql(sort, filter.length > 0),
      [communityId, ...filter, limit, (page - 1) * limit],
    );
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(modQueueCountSql(filter.length > 0), [communityId, ...filter]);

    const targets = entries.map(({ target_type, target_id }) => ({
      type: target_type,
      id: target_id,
    }));
    const [reports, reasons, contents] = await Promise.all([
      this.openReportsOf(communityId, targets),
      this.reasonsOf(communityId, targets),
      this.contentOf(targets),
    ]);
    return {
      items: entries.map((entry) => {
        const key = `${entry.target_type}:${entry.target_id}`;
        return {
          target_type: entry.target_type,
          target_id: entry.target_id,
          target: contents.get(key) ?? null,
          report_count: Number(entry.report_count),
          reporter_count: Number(entry.reporter_count),
          reasons: reasons.get(key) ?? {},
          first_reported_at: iso(entry.first_reported_at),
          last_reported_at: iso(entry.last_reported_at),
          reports: reports.get(key) ?? [],
        };
      }),
      page,
      limit,
      total: Number(counts[0]?.total ?? 0),
    };
  }

  // GET /communities/:name/reports: the reports themselves, one per item,
  // with their content and how many open reports it has. Withdrawn reports
  // are not listed: the reporter took them back.
  async list(
    name: string,
    actorId: string,
    query: ListCommunityReportsDto,
  ): Promise<Page<CommunityReportDto>> {
    const communityId = await this.authorize(this.pool, name, actorId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const status = query.status ?? 'open';
    const filters = ['community_id = ?', 'withdrawn_at IS NULL'];
    const values: string[] = [communityId];
    if (status === 'any') {
      filters.push('community_status IS NOT NULL');
    } else {
      filters.push('community_status = ?');
      values.push(status);
    }
    if (query.target_type) {
      filters.push('target_type = ?');
      values.push(query.target_type);
    }
    const where = filters.join(' AND ');
    const direction = query.sort === 'oldest' ? 'ASC' : 'DESC';
    const [rows] = await this.pool.execute<ReportRow[]>(
      `SELECT id, target_type, target_id, reason, description, created_at,
         community_status, community_reviewed_at
       FROM user_reports WHERE ${where}
       ORDER BY created_at ${direction}, id ${direction} LIMIT ? OFFSET ?`,
      [...values, limit, (page - 1) * limit],
    );
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total FROM user_reports WHERE ${where}`, values);
    return {
      items: await this.toReports(this.pool, communityId, rows),
      page,
      limit,
      total: Number(counts[0]?.total ?? 0),
    };
  }

  // GET /communities/:name/reports/:id. A report of another community, an
  // account or community report (never routed here), and a withdrawn one are
  // all 404: the id says nothing about what it is.
  async findOne(
    name: string,
    actorId: string,
    id: string,
  ): Promise<CommunityReportDetailDto> {
    const communityId = await this.authorize(this.pool, name, actorId);
    return this.detail(this.pool, communityId, id);
  }

  // POST /communities/:name/reports/:id/approve: the content is fine. Closes
  // every open report of it, the whole queue entry, and logs
  // report_approved. The content is untouched and leaves the queue; a new
  // report by someone else opens a new entry, one by the same reporter is
  // refused (ReportsService.create).
  async approve(
    name: string,
    actorId: string,
    id: string,
  ): Promise<CommunityReportDetailDto> {
    return this.inTransaction(async (connection) => {
      const communityId = await this.authorize(connection, name, actorId);
      const report = await this.openReport(connection, communityId, id, true);
      await closeCommunityReports(connection, this.moderationLog, {
        status: 'approved',
        actorId,
        communityId,
        targetType: report.target_type,
        targetId: report.target_id,
      });
      return this.detail(connection, communityId, id);
    });
  }

  // POST /communities/:name/reports/:id/remove: removes the content and
  // closes its reports in one transaction, through the same removal path as
  // POST /posts/:id/remove and POST /comments/:id/remove (the author's
  // notification, post_removed or comment_removed, report_removed). Content
  // a moderator already removed only has its reports closed.
  async remove(
    name: string,
    actorId: string,
    id: string,
    input: RemoveContentDto,
  ): Promise<CommunityReportDetailDto> {
    return this.inTransaction(async (connection) => {
      const communityId = await this.authorize(connection, name, actorId);
      // Read without a lock: the removal locks the content row first, then
      // updates the reports, the order POST /posts/:id/remove takes, so the
      // two can never deadlock. The state is checked again under the locks.
      const report = await this.openReport(connection, communityId, id, false);
      const removed = await this.contentRemovedAt(
        connection,
        report.target_type,
        report.target_id,
      );
      if (removed === undefined) {
        throw new ConflictException(
          'The content no longer exists; approve the report to close it',
        );
      }
      if (removed === null) {
        if (report.target_type === 'post') {
          await this.posts.removeContentOn(
            connection,
            report.target_id,
            input,
            actorId,
          );
        } else {
          await this.commentRemovals.removeOn(
            connection,
            report.target_id,
            input,
            actorId,
          );
        }
      } else {
        const closed = await closeCommunityReports(
          connection,
          this.moderationLog,
          {
            status: 'removed',
            actorId,
            communityId,
            targetType: report.target_type,
            targetId: report.target_id,
          },
        );
        if (closed === 0) {
          throw new ConflictException('The report was decided concurrently');
        }
      }
      const after = await this.detail(connection, communityId, id);
      if (after.community_status !== 'removed') {
        throw new ConflictException('The report was decided concurrently');
      }
      return after;
    });
  }

  private async authorize(
    executor: Pick<Pool | PoolConnection, 'execute'>,
    name: string,
    actorId: string,
  ): Promise<string> {
    const [rows] = await executor.execute<
      (RowDataPacket & {
        id: string;
        can_moderate: number | string | boolean;
      })[]
    >(MODERATED_COMMUNITY_SQL, [actorId, actorId, name]);
    const community = rows[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    if (!isSqlTrue(community.can_moderate)) {
      throw new ForbiddenException(
        "Only the community's creator and moderators can review its reports",
      );
    }
    return community.id;
  }

  // The report to decide: this community's, not withdrawn (404 otherwise),
  // still open at the community level (409 otherwise).
  private async openReport(
    connection: PoolConnection,
    communityId: string,
    id: string,
    lock: boolean,
  ): Promise<ReportRow> {
    const [rows] = await connection.execute<ReportRow[]>(
      `SELECT id, target_type, target_id, reason, description, created_at,
         community_status, community_reviewed_at
       FROM user_reports
       WHERE id = ? AND community_id = ? AND withdrawn_at IS NULL
       LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [id, communityId],
    );
    const report = rows[0];
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    if (report.community_status !== 'open') {
      throw new ConflictException('This report is already closed');
    }
    return report;
  }

  // undefined when the content is gone (its author deleted it).
  private async contentRemovedAt(
    connection: PoolConnection,
    type: CommunityReportTarget,
    id: string,
  ): Promise<Date | string | null | undefined> {
    const [rows] = await connection.execute<
      (RowDataPacket & { removed_at: Date | string | null })[]
    >(
      `SELECT removed_at FROM ${type === 'post' ? 'posts' : 'comments'} WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ? rows[0].removed_at : undefined;
  }

  private async detail(
    executor: Pick<Pool | PoolConnection, 'execute'>,
    communityId: string,
    id: string,
  ): Promise<CommunityReportDetailDto> {
    const [rows] = await executor.execute<ReportRow[]>(
      `SELECT ur.id, ur.target_type, ur.target_id, ur.reason, ur.description, ur.created_at,
         ur.community_status, ur.community_reviewed_at,
         IF(reviewer.deleted_at IS NULL, reviewer.username, NULL) AS community_reviewed_by_username
       FROM user_reports ur
       LEFT JOIN users reviewer ON reviewer.id = ur.community_reviewed_by
       WHERE ur.id = ? AND ur.community_id = ? AND ur.withdrawn_at IS NULL
       LIMIT 1`,
      [id, communityId],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Report not found');
    }
    const [report] = await this.toReports(executor, communityId, [row]);
    const others = await this.openReportsOf(
      communityId,
      [{ type: row.target_type, id: row.target_id }],
      executor,
    );
    return {
      ...report,
      community_reviewed_by_username:
        row.community_reviewed_by_username ?? null,
      other_open_reports: (
        others.get(`${row.target_type}:${row.target_id}`) ?? []
      ).filter((other) => other.id !== row.id),
    };
  }

  private async toReports(
    executor: Pick<Pool | PoolConnection, 'execute'>,
    communityId: string,
    rows: ReportRow[],
  ): Promise<CommunityReportDto[]> {
    const targets = [
      ...new Map(
        rows.map((row) => [
          `${row.target_type}:${row.target_id}`,
          { type: row.target_type, id: row.target_id },
        ]),
      ).values(),
    ];
    const [contents, counts] = await Promise.all([
      this.contentOf(targets, executor),
      this.openCountsOf(communityId, targets, executor),
    ]);
    return rows.map((row) => {
      const key = `${row.target_type}:${row.target_id}`;
      return {
        id: row.id,
        reason: row.reason,
        description: row.description,
        created_at: iso(row.created_at),
        target_type: row.target_type,
        target_id: row.target_id,
        target: contents.get(key) ?? null,
        community_status: row.community_status,
        community_reviewed_at: isoOrNull(row.community_reviewed_at),
        open_reports_on_target: counts.get(key)?.reports ?? 0,
        open_reporters_on_target: counts.get(key)?.reporters ?? 0,
      };
    });
  }

  // The newest ENTRY_REPORTS_SHOWN open reports of each target, in one
  // statement: ROW_NUMBER() bounds each entry, so a heavily reported post
  // never makes a page unbounded.
  private async openReportsOf(
    communityId: string,
    targets: Array<{ type: CommunityReportTarget; id: string }>,
    executor: Pick<Pool | PoolConnection, 'execute'> = this.pool,
  ): Promise<Map<string, CommunityReportItemDto[]>> {
    const result = new Map<string, CommunityReportItemDto[]>();
    if (targets.length === 0) {
      return result;
    }
    const [rows] = await executor.execute<ReportRow[]>(
      `SELECT id, target_type, target_id, reason, description, created_at FROM (
         SELECT id, target_type, target_id, reason, description, created_at,
           ROW_NUMBER() OVER (PARTITION BY target_type, target_id ORDER BY created_at DESC, id DESC) AS position
         FROM user_reports
         WHERE community_id = ? AND ${OPEN_COMMUNITY_REPORT_SQL} AND (${targetsMatch(targets.length)})
       ) AS ranked
       WHERE position <= ?
       ORDER BY created_at DESC, id DESC`,
      [
        communityId,
        ...targets.flatMap(({ type, id }) => [type, id]),
        ENTRY_REPORTS_SHOWN,
      ],
    );
    for (const row of rows) {
      const key = `${row.target_type}:${row.target_id}`;
      const list = result.get(key) ?? [];
      list.push({
        id: row.id,
        reason: row.reason,
        description: row.description,
        created_at: iso(row.created_at),
      });
      result.set(key, list);
    }
    return result;
  }

  private async reasonsOf(
    communityId: string,
    targets: Array<{ type: CommunityReportTarget; id: string }>,
  ): Promise<Map<string, Partial<Record<ReportReason, number>>>> {
    const result = new Map<string, Partial<Record<ReportReason, number>>>();
    if (targets.length === 0) {
      return result;
    }
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        target_type: string;
        target_id: string;
        reason: ReportReason;
        reports: number | string;
      })[]
    >(
      `SELECT target_type, target_id, reason, COUNT(*) AS reports
       FROM user_reports
       WHERE community_id = ? AND ${OPEN_COMMUNITY_REPORT_SQL} AND (${targetsMatch(targets.length)})
       GROUP BY target_type, target_id, reason`,
      [communityId, ...targets.flatMap(({ type, id }) => [type, id])],
    );
    for (const row of rows) {
      const key = `${row.target_type}:${row.target_id}`;
      result.set(key, {
        ...result.get(key),
        [row.reason]: Number(row.reports),
      });
    }
    return result;
  }

  private async openCountsOf(
    communityId: string,
    targets: Array<{ type: CommunityReportTarget; id: string }>,
    executor: Pick<Pool | PoolConnection, 'execute'>,
  ): Promise<Map<string, { reports: number; reporters: number }>> {
    const result = new Map<string, { reports: number; reporters: number }>();
    if (targets.length === 0) {
      return result;
    }
    const [rows] = await executor.execute<
      (RowDataPacket & {
        target_type: string;
        target_id: string;
        reports: number | string;
        reporters: number | string;
      })[]
    >(
      `SELECT target_type, target_id, COUNT(*) AS reports, COUNT(DISTINCT reporter_id) AS reporters
       FROM user_reports
       WHERE community_id = ? AND ${OPEN_COMMUNITY_REPORT_SQL} AND (${targetsMatch(targets.length)})
       GROUP BY target_type, target_id`,
      [communityId, ...targets.flatMap(({ type, id }) => [type, id])],
    );
    for (const row of rows) {
      result.set(`${row.target_type}:${row.target_id}`, {
        reports: Number(row.reports),
        reporters: Number(row.reporters),
      });
    }
    return result;
  }

  // The reported posts and comments of a page, one statement each.
  private async contentOf(
    targets: Array<{ type: CommunityReportTarget; id: string }>,
    executor: Pick<Pool | PoolConnection, 'execute'> = this.pool,
  ): Promise<Map<string, ReportedContentDto>> {
    const result = new Map<string, ReportedContentDto>();
    const ids = (type: CommunityReportTarget) =>
      targets.filter((target) => target.type === type).map(({ id }) => id);
    const placeholders = (count: number) =>
      Array.from({ length: count }, () => '?').join(', ');
    const load = async (type: CommunityReportTarget, sql: string) => {
      const list = ids(type);
      if (list.length === 0) {
        return;
      }
      const [rows] = await executor.execute<ContentRow[]>(
        `${sql} (${placeholders(list.length)})`,
        list,
      );
      for (const row of rows) {
        result.set(`${type}:${row.id}`, {
          type,
          id: row.id,
          post_id: row.post_id,
          title: row.title,
          excerpt: row.excerpt,
          author_username: row.author_deleted_at ? null : row.author_username,
          created_at: iso(row.created_at),
          removed: row.removed_at !== null,
        });
      }
    };
    await load(
      'post',
      `SELECT p.id, NULL AS post_id, p.title, LEFT(p.content, 300) AS excerpt,
         u.username AS author_username, u.deleted_at AS author_deleted_at,
         p.created_at, p.removed_at
       FROM posts p LEFT JOIN users u ON u.id = p.author_id
       WHERE p.id IN`,
    );
    await load(
      'comment',
      `SELECT c.id, c.post_id, NULL AS title, LEFT(c.content, 300) AS excerpt,
         u.username AS author_username, u.deleted_at AS author_deleted_at,
         c.created_at, c.removed_at
       FROM comments c LEFT JOIN users u ON u.id = c.author_id
       WHERE c.id IN`,
    );
    return result;
  }

  private async inTransaction<T>(
    work: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    let started = false;
    try {
      await connection.beginTransaction();
      started = true;
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      if (started) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
