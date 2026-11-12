import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  SAFE_ROUTE_PARAM_PATTERNS,
  type SafeRouteParamKind,
} from '../common/safe-route-param.pipe';
import { CreateReportDto } from './dto/create-report.dto';
import { ListOwnReportsDto } from './dto/list-own-reports.dto';
import { isReportReason } from './report.constants';
import type {
  ReportContextType,
  ReportReason,
  ReportStatus,
  ReportTargetType,
} from './report.constants';
import { REPORT_TARGET_JOINS_SQL } from './report-target.sql';
import type { CommunityReportStatus } from './community-report-review';
import { visibleCommunityColumnsSql } from '../common/community-visibility';

interface ReportedUserRow extends RowDataPacket {
  id: string;
  username: string;
}

interface ContentAuthorRow extends RowDataPacket {
  author_id: string;
  community_id: string;
}

interface ReportedCommunityRow extends RowDataPacket {
  id: string;
  creator_id: string;
}

interface ExistingReportRow extends RowDataPacket {
  id: string;
}

interface CreatedReportRow extends RowDataPacket {
  created_at: Date | string;
}

interface OwnReportRow extends RowDataPacket {
  id: string;
  target_type: ReportTargetType;
  target_label: string | null;
  reason: ReportReason;
  description: string | null;
  status: ReportStatus;
  community_status: CommunityReportStatus | null;
  created_at: Date | string;
  withdrawn_at: Date | string | null;
}

interface WithdrawalRow extends RowDataPacket {
  reporter_id: string | null;
  status: ReportStatus;
  community_status: CommunityReportStatus | null;
  withdrawn_at: Date | string | null;
}

/**
 * A report as its reporter sees it. Deliberately has no resolution,
 * resolution_note, reviewed_by, reviewed_at or reported_user_id: the
 * resolution describes what happened to another person's account, the note is
 * internal, and the reviewer must not be named to someone who may be hostile
 * to the decision (#44, "Data classification" in the README). status is the
 * most a reporter learns about the outcome, as in the report_resolved
 * notification.
 */
export interface OwnReportDto {
  id: string;
  target_type: ReportTargetType;
  target_label: string | null;
  reason: ReportReason;
  description: string | null;
  status: ReportStatus;
  // The community moderators' review of a post or comment report
  // (migration 036): open, approved (the content stays) or removed; null for
  // a report only administrators review. Never who decided.
  community_status: CommunityReportStatus | null;
  created_at: string;
  withdrawn_at: string | null;
}

export interface OwnReportList {
  items: OwnReportDto[];
  page: number;
  limit: number;
  total: number;
}

// Only what the public can still read: an anonymised account, removed content
// and a deleted community label as null, so this route never shows a removed
// post's title or comment text that GET /posts/:id hides from everyone but
// reviewers. Removal and deletion are publicly observable anyway, so the null
// tells the reporter nothing about the moderation outcome.
const OWN_REPORT_TARGET_LABEL_SQL = `CASE ur.target_type
           WHEN 'user' THEN IF(target_user.deleted_at IS NULL, target_user.username, NULL)
           WHEN 'post' THEN IF(target_post.removed_at IS NULL, target_post.title, NULL)
           WHEN 'comment' THEN IF(target_comment.removed_at IS NULL, LEFT(target_comment.content, 100), NULL)
           WHEN 'community' THEN IF(${visibleCommunityColumnsSql('target_community')}, target_community.name, NULL)
         END AS target_label`;

// The column list is the response's allow-list: nothing moderator-only is ever
// selected, so nothing moderator-only can leak through a mapping mistake.
const OWN_REPORT_SELECT_SQL = `SELECT ur.id, ur.target_type, ${OWN_REPORT_TARGET_LABEL_SQL},
         ur.reason, ur.description, ur.status, ur.community_status, ur.created_at, ur.withdrawn_at
       FROM user_reports ur
       ${REPORT_TARGET_JOINS_SQL}`;

function toOwnReport(row: OwnReportRow): OwnReportDto {
  return {
    id: row.id,
    target_type: row.target_type,
    target_label: row.target_label,
    reason: row.reason,
    description: row.description,
    status: row.status,
    community_status: row.community_status ?? null,
    created_at: new Date(row.created_at).toISOString(),
    withdrawn_at:
      row.withdrawn_at === null
        ? null
        : new Date(row.withdrawn_at).toISOString(),
  };
}

export interface CreatedReportDto {
  id: string;
  target_type: ReportTargetType;
  target: string;
  reported_username: string | null;
  reason: ReportReason;
  status: 'open';
  created_at: string;
}

interface ResolvedTarget {
  type: ReportTargetType;
  id: string;
  reportedUserId: string | null;
  targetAuthorId: string | null;
  reportedUsername: string | null;
  // The community whose moderators review it: a post's, or a comment's
  // post's. null for an account or community report: administrators only.
  communityId: string | null;
}

// The same formats the API addresses each resource by in its routes.
const TARGET_FORMATS: Record<ReportTargetType, SafeRouteParamKind> = {
  user: 'username',
  community: 'communityName',
  post: 'id',
  comment: 'id',
};

@Injectable()
export class ReportsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // Deliberately takes no CommunityRuleAcceptanceService: a user must be able
  // to report the content that made them decline a community's rules.
  async create(
    input: CreateReportDto,
    reporterId: string,
  ): Promise<CreatedReportDto> {
    if (!isReportReason(input.reason)) {
      throw new BadRequestException('Invalid report reason');
    }

    const target = await this.resolveTarget(input, reporterId);
    // The DTO refuses context on any other target; it is never stored for one.
    const context =
      target.type === 'user' && input.context_type && input.context_id
        ? { type: input.context_type, id: input.context_id }
        : null;
    if (context) {
      await this.assertContextBelongsTo(context, target.id);
    }

    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    const id = randomUUID();

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      // Lock the reporter row to serialize concurrent duplicate submissions by this account.
      await connection.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [
        reporterId,
      ]);
      // Keyed on the target plus the evidence: a report about the same account
      // with different evidence is a new report, and reports about two posts
      // by one author never collide. Only a user target has evidence, so any
      // other target has one active report per reporter. A withdrawn report
      // keeps status 'open', so it is excluded explicitly: withdrawing frees
      // the slot, or the reporter could never report that target again.
      const [existingReports] = await connection.execute<ExistingReportRow[]>(
        `SELECT id FROM user_reports
         WHERE reporter_id = ? AND target_type = ? AND target_id = ?
           AND status IN ('open', 'under_review') AND withdrawn_at IS NULL
           AND context_type <=> ? AND context_id <=> ?
         FOR UPDATE`,
        [
          reporterId,
          target.type,
          target.id,
          context?.type ?? null,
          context?.id ?? null,
        ],
      );
      if (existingReports[0]) {
        throw new ConflictException('An active report already exists');
      }
      // A report the community's moderators closed stays closed: the same
      // reporter cannot put the content back in the queue by reporting it
      // again. Another reporter can; that is new information.
      if (target.communityId) {
        const [decided] = await connection.execute<ExistingReportRow[]>(
          `SELECT id FROM user_reports
           WHERE reporter_id = ? AND target_type = ? AND target_id = ?
             AND community_status IN ('approved', 'removed')
           LIMIT 1`,
          [reporterId, target.type, target.id],
        );
        if (decided[0]) {
          throw new ConflictException(
            "The community's moderators have already reviewed your report of this content",
          );
        }
      }

      await connection.execute<ResultSetHeader>(
        `INSERT INTO user_reports
         (id, reporter_id, reported_user_id, reason, description, context_type, context_id,
          target_type, target_id, target_author_id, community_id, community_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          reporterId,
          target.reportedUserId,
          input.reason,
          input.description ?? null,
          context?.type ?? null,
          context?.id ?? null,
          target.type,
          target.id,
          target.targetAuthorId,
          target.communityId,
          target.communityId ? 'open' : null,
        ],
      );

      const [reports] = await connection.execute<CreatedReportRow[]>(
        'SELECT created_at FROM user_reports WHERE id = ? LIMIT 1',
        [id],
      );
      if (!reports[0]) {
        throw new Error('Created report could not be retrieved');
      }

      await connection.commit();
      return {
        id,
        target_type: target.type,
        target: input.target,
        reported_username: target.reportedUsername,
        reason: input.reason,
        status: 'open',
        created_at: new Date(reports[0].created_at).toISOString(),
      };
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  // The reporter is always the caller; nothing lets one account name another's.
  // Served by idx_user_reports_reporter_created (reporter_id, created_at).
  async listOwn(
    reporterId: string,
    query: ListOwnReportsDto,
  ): Promise<OwnReportList> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const filters = ['ur.reporter_id = ?'];
    const values: string[] = [reporterId];
    if (query.status) {
      filters.push('ur.status = ?');
      values.push(query.status);
    }
    if (query.target_type) {
      filters.push('ur.target_type = ?');
      values.push(query.target_type);
    }
    const where = filters.join(' AND ');
    const order = query.sort === 'oldest' ? 'ASC' : 'DESC';

    const [rows] = await this.pool.execute<OwnReportRow[]>(
      `${OWN_REPORT_SELECT_SQL}
       WHERE ${where}
       ORDER BY ur.created_at ${order}, ur.id ${order} LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total FROM user_reports ur WHERE ${where}`, values);

    return {
      items: rows.map(toOwnReport),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  // Another reporter's report is 404, not 403: 403 would confirm it exists.
  async findOwn(id: string, reporterId: string): Promise<OwnReportDto> {
    const [rows] = await this.pool.execute<OwnReportRow[]>(
      `${OWN_REPORT_SELECT_SQL}
       WHERE ur.id = ? AND ur.reporter_id = ? LIMIT 1`,
      [id, reporterId],
    );
    if (!rows[0]) {
      throw new NotFoundException('Report not found');
    }
    return toOwnReport(rows[0]);
  }

  // A state change, never a DELETE: user_restrictions.report_id and the
  // admin_actions audit trail refer to the row, and a reporter must not erase a
  // record a moderator has acted on. Only an open report can be withdrawn; once
  // under_review, a moderator's work has started. No audit entry (admin_actions
  // is for platform admins) and no notification (the reporter is the actor, and
  // the reported party was never told): withdrawn_at is the record.
  async withdraw(id: string, reporterId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const [rows] = await connection.execute<WithdrawalRow[]>(
        `SELECT reporter_id, status, community_status, withdrawn_at FROM user_reports
         WHERE id = ? LIMIT 1 FOR UPDATE`,
        [id],
      );
      const report = rows[0];
      if (!report || report.reporter_id !== reporterId) {
        throw new NotFoundException('Report not found');
      }
      if (report.withdrawn_at !== null) {
        throw new ConflictException('Report is already withdrawn');
      }
      // Open at both levels: once a moderator of either has decided, there
      // is nothing left to withdraw.
      if (
        report.status !== 'open' ||
        (report.community_status ?? 'open') !== 'open'
      ) {
        throw new ConflictException('Only an open report can be withdrawn');
      }

      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE user_reports SET withdrawn_at = UTC_TIMESTAMP()
         WHERE id = ? AND reporter_id = ? AND withdrawn_at IS NULL
           AND status = 'open'`,
        [id, reporterId],
      );
      // The row is locked, so this only fails if something bypassed the lock.
      if (result.affectedRows !== 1) {
        throw new ConflictException('Report changed concurrently');
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
  }

  // None of these filter on removed, deleted or suspended: a report is a
  // request to review something the reporter saw, and refusing it because a
  // moderator already acted would discard information about the same actor.
  private async resolveTarget(
    input: CreateReportDto,
    reporterId: string,
  ): Promise<ResolvedTarget> {
    if (
      !SAFE_ROUTE_PARAM_PATTERNS[TARGET_FORMATS[input.target_type]].test(
        input.target,
      )
    ) {
      throw new BadRequestException('Invalid report target');
    }

    switch (input.target_type) {
      case 'user':
        return this.resolveUser(input.target, reporterId);
      case 'community':
        return this.resolveCommunity(input.target, reporterId);
      case 'post':
      case 'comment':
        return this.resolveContent(input.target_type, input.target, reporterId);
    }
  }

  private async resolveUser(
    username: string,
    reporterId: string,
  ): Promise<ResolvedTarget> {
    const [users] = await this.pool.execute<ReportedUserRow[]>(
      'SELECT id, username FROM users WHERE username = ? LIMIT 1',
      [username],
    );
    const user = users[0];
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.id === reporterId) {
      throw new BadRequestException('Invalid report target');
    }
    return {
      type: 'user',
      id: user.id,
      reportedUserId: user.id,
      targetAuthorId: null,
      reportedUsername: user.username,
      communityId: null,
    };
  }

  private async resolveContent(
    type: ReportContextType,
    id: string,
    reporterId: string,
  ): Promise<ResolvedTarget> {
    const { author_id: authorId, community_id: communityId } =
      await this.contentAuthor(type, id);
    // chk_user_reports_not_self would also refuse this, with a worse message.
    if (authorId === reporterId) {
      throw new BadRequestException(`You cannot report your own ${type}`);
    }
    // Only a user target names the account in the response: a post's author may
    // be hidden, and a deleted author's placeholder username contains their ID.
    return {
      type,
      id,
      reportedUserId: authorId,
      targetAuthorId: authorId,
      reportedUsername: null,
      communityId,
    };
  }

  private async resolveCommunity(
    name: string,
    reporterId: string,
  ): Promise<ResolvedTarget> {
    const [communities] = await this.pool.execute<ReportedCommunityRow[]>(
      'SELECT id, creator_id FROM communities WHERE name = ? LIMIT 1',
      [name],
    );
    const community = communities[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    // reported_user_id is NULL here, so no constraint catches this one.
    if (community.creator_id === reporterId) {
      throw new BadRequestException(
        'You cannot report a community you created',
      );
    }
    return {
      type: 'community',
      id: community.id,
      reportedUserId: null,
      targetAuthorId: null,
      reportedUsername: null,
      communityId: null,
    };
  }

  private async assertContextBelongsTo(
    context: { type: ReportContextType; id: string },
    reportedUserId: string,
  ): Promise<void> {
    if (
      (await this.contentAuthor(context.type, context.id)).author_id !==
      reportedUserId
    ) {
      throw new BadRequestException('Invalid report context');
    }
  }

  // The content's author and community: a post's own, a comment's through
  // its post.
  private async contentAuthor(
    type: ReportContextType,
    id: string,
  ): Promise<ContentAuthorRow> {
    const [rows] = await this.pool.execute<ContentAuthorRow[]>(
      type === 'post'
        ? 'SELECT author_id, community_id FROM posts WHERE id = ? LIMIT 1'
        : 'SELECT comments.author_id, posts.community_id FROM comments JOIN posts ON posts.id = comments.post_id WHERE comments.id = ? LIMIT 1',
      [id],
    );
    if (!rows[0]) {
      throw new NotFoundException(
        type === 'post' ? 'Post not found' : 'Comment not found',
      );
    }
    return rows[0];
  }
}
