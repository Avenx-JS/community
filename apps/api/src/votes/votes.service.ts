import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { CreateVoteDto } from './dto/create-vote.dto';

interface VoteRow extends RowDataPacket {
  id: string;
  user_id: string;
  target_type: 'post' | 'comment';
  target_id: string;
  value: -1 | 1;
  created_at: Date | string;
}

export interface VoteResponseDto {
  id: string;
  user_id: string;
  target_type: 'post' | 'comment';
  target_id: string;
  value: -1 | 1;
  created_at: string;
  score: number;
}

@Injectable()
export class VotesService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async vote(input: CreateVoteDto, userId: string): Promise<VoteResponseDto> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;
      await this.lockTarget(connection, input.target_type, input.target_id);

      await connection.execute<ResultSetHeader>(
        'INSERT INTO votes (id, user_id, target_type, target_id, value) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [randomUUID(), userId, input.target_type, input.target_id, input.value],
      );

      const [votes] = await connection.execute<VoteRow[]>(
        'SELECT id, user_id, target_type, target_id, value, created_at FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        [userId, input.target_type, input.target_id],
      );
      const vote = votes[0];
      if (!vote) {
        throw new Error('Saved vote could not be retrieved');
      }

      const [scores] = await connection.execute<
        (RowDataPacket & { score: number | string })[]
      >(
        'SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE target_type = ? AND target_id = ?',
        [input.target_type, input.target_id],
      );

      await connection.commit();

      return {
        id: vote.id,
        user_id: vote.user_id,
        target_type: vote.target_type,
        target_id: vote.target_id,
        value: vote.value,
        created_at: new Date(vote.created_at).toISOString(),
        score: Number(scores[0].score),
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

  private async lockTarget(
    connection: PoolConnection,
    targetType: CreateVoteDto['target_type'],
    targetId: string,
  ): Promise<void> {
    const table = targetType === 'post' ? 'posts' : 'comments';
    const [targets] = await connection.execute<
      (RowDataPacket & { id: string })[]
    >(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [targetId]);

    if (!targets[0]) {
      throw new NotFoundException(
        targetType === 'post' ? 'Post not found' : 'Comment not found',
      );
    }
  }
}
