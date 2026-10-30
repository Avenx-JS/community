import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
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
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly ruleAcceptance: CommunityRuleAcceptanceService,
  ) {}

  async vote(input: CreateVoteDto, userId: string): Promise<VoteResponseDto> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const communityId = await this.lockTarget(
        connection,
        input.target_type,
        input.target_id,
      );
      // Voting is participation: gated on the target's community rules,
      // after the 404 for an unknown target, on the transaction's connection.
      await this.ruleAcceptance.assertAcceptedOrThrow(
        userId,
        communityId,
        connection,
      );

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

  // Locks the target row and returns its community. A comment's community is
  // its post's; only the comment row is locked, not the post.
  private async lockTarget(
    connection: PoolConnection,
    targetType: CreateVoteDto['target_type'],
    targetId: string,
  ): Promise<string> {
    const [targets] = await connection.execute<
      (RowDataPacket & { id: string; community_id: string })[]
    >(
      targetType === 'post'
        ? 'SELECT id, community_id FROM posts WHERE id = ? FOR UPDATE'
        : `SELECT comments.id, posts.community_id
           FROM comments
           INNER JOIN posts ON posts.id = comments.post_id
           WHERE comments.id = ? FOR UPDATE OF comments`,
      [targetId],
    );

    const target = targets[0];
    if (!target) {
      throw new NotFoundException(
        targetType === 'post' ? 'Post not found' : 'Comment not found',
      );
    }
    return target.community_id;
  }
}
