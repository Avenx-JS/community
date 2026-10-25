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
import { CreateReportDto } from './dto/create-report.dto';
import { isReportReason } from './report.constants';
import type { ReportContextType, ReportReason } from './report.constants';

interface ReportedUserRow extends RowDataPacket {
  id: string;
  username: string;
}

interface ReportContextRow extends RowDataPacket {
  author_id: string;
}

interface ExistingReportRow extends RowDataPacket {
  id: string;
}

interface CreatedReportRow extends RowDataPacket {
  created_at: Date | string;
}

export interface CreatedReportDto {
  id: string;
  reported_username: string;
  reason: ReportReason;
  status: 'open';
  created_at: string;
}

@Injectable()
export class ReportsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async create(
    input: CreateReportDto,
    reporterId: string,
  ): Promise<CreatedReportDto> {
    if (!isReportReason(input.reason)) {
      throw new BadRequestException('Invalid report reason');
    }

    const [users] = await this.pool.execute<ReportedUserRow[]>(
      'SELECT id, username FROM users WHERE username = ? LIMIT 1',
      [input.username],
    );
    const reportedUser = users[0];
    if (!reportedUser) {
      throw new NotFoundException('User not found');
    }

    if (reportedUser.id === reporterId) {
      throw new BadRequestException('Invalid report target');
    }

    if (input.context_type && input.context_id) {
      const table = this.contextTable(input.context_type);
      const [contexts] = await this.pool.execute<ReportContextRow[]>(
        `SELECT author_id FROM ${table} WHERE id = ? LIMIT 1`,
        [input.context_id],
      );
      const context = contexts[0];
      if (!context) {
        throw new NotFoundException(
          input.context_type === 'post'
            ? 'Post not found'
            : 'Comment not found',
        );
      }
      if (context.author_id !== reportedUser.id) {
        throw new BadRequestException('Invalid report context');
      }
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
      const [existingReports] = await connection.execute<ExistingReportRow[]>(
        `SELECT id FROM user_reports
         WHERE reporter_id = ? AND reported_user_id = ?
           AND status IN ('open', 'under_review')
           AND context_type <=> ? AND context_id <=> ?
         FOR UPDATE`,
        [
          reporterId,
          reportedUser.id,
          input.context_type ?? null,
          input.context_id ?? null,
        ],
      );
      if (existingReports[0]) {
        throw new ConflictException('An active report already exists');
      }

      await connection.execute<ResultSetHeader>(
        `INSERT INTO user_reports
         (id, reporter_id, reported_user_id, reason, description, context_type, context_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          reporterId,
          reportedUser.id,
          input.reason,
          input.description ?? null,
          input.context_type ?? null,
          input.context_id ?? null,
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
        reported_username: reportedUser.username,
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

  private contextTable(contextType: ReportContextType): 'posts' | 'comments' {
    return contextType === 'post' ? 'posts' : 'comments';
  }
}
