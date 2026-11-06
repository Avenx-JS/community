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
import { isReportReason } from './report.constants';
import type {
  ReportContextType,
  ReportReason,
  ReportTargetType,
} from './report.constants';

interface ReportedUserRow extends RowDataPacket {
  id: string;
  username: string;
}

interface ContentAuthorRow extends RowDataPacket {
  author_id: string;
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
      // other target has one active report per reporter.
      const [existingReports] = await connection.execute<ExistingReportRow[]>(
        `SELECT id FROM user_reports
         WHERE reporter_id = ? AND target_type = ? AND target_id = ?
           AND status IN ('open', 'under_review')
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

      await connection.execute<ResultSetHeader>(
        `INSERT INTO user_reports
         (id, reporter_id, reported_user_id, reason, description, context_type, context_id,
          target_type, target_id, target_author_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    };
  }

  private async resolveContent(
    type: ReportContextType,
    id: string,
    reporterId: string,
  ): Promise<ResolvedTarget> {
    const authorId = await this.contentAuthor(type, id);
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
    };
  }

  private async assertContextBelongsTo(
    context: { type: ReportContextType; id: string },
    reportedUserId: string,
  ): Promise<void> {
    if (
      (await this.contentAuthor(context.type, context.id)) !== reportedUserId
    ) {
      throw new BadRequestException('Invalid report context');
    }
  }

  private async contentAuthor(
    type: ReportContextType,
    id: string,
  ): Promise<string> {
    const table = this.contextTable(type);
    const [rows] = await this.pool.execute<ContentAuthorRow[]>(
      `SELECT author_id FROM ${table} WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!rows[0]) {
      throw new NotFoundException(
        type === 'post' ? 'Post not found' : 'Comment not found',
      );
    }
    return rows[0].author_id;
  }

  private contextTable(contextType: ReportContextType): 'posts' | 'comments' {
    return contextType === 'post' ? 'posts' : 'comments';
  }
}
