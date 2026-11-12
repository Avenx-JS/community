import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { isSqlTrue } from '../common/community-moderation';
import { randomUUID } from 'node:crypto';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunityBanPolicyService } from '../communities/community-ban-policy.service';
import {
  readableCommunitySql,
  visibleCommunitySql,
} from '../common/community-visibility';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { UserBlockPolicyService } from '../users/user-block-policy.service';
import {
  RECOMPUTE_COMMENT_RANKING_SQL,
  RECOMPUTE_POST_RANKING_SQL,
} from '../common/content-ranking';

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

// GET …/vote: the caller's own vote (null when they have none) and the score.
export interface VoteStateDto {
  value: -1 | 1 | null;
  score: number;
}

// DELETE …/vote: the score after the withdrawal.
export interface VoteScoreDto {
  score: number;
}

// The one vote path's input. PUT /posts/:id/vote and PUT /comments/:id/vote
// build it from the route (target) and CastVoteDto (value).
export interface VoteInput {
  target_type: 'post' | 'comment';
  target_id: string;
  value: -1 | 1;
}

type VoteTarget = VoteInput['target_type'];
interface VoteTargetState {
  communityId: string;
  authorId: string;
  removed: boolean;
}
type Executor = Pick<Pool | PoolConnection, 'execute'>;

// Served by unique_user_target (user_id, target_type, target_id).
export const OWN_VOTE_SQL =
  'SELECT value FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ? LIMIT 1';
// Served by idx_votes_target (target_type, target_id, value), covering.
export const SCORE_SQL =
  'SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE target_type = ? AND target_id = ?';

@Injectable()
export class VotesService {
  private readonly blocks: UserBlockPolicyService;
  private readonly bans: CommunityBanPolicyService;

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly ruleAcceptance: CommunityRuleAcceptanceService,
    @Optional() blocks?: UserBlockPolicyService,
    @Optional() bans?: CommunityBanPolicyService,
  ) {
    this.blocks = blocks ?? new UserBlockPolicyService(pool);
    this.bans = bans ?? new CommunityBanPolicyService(pool);
  }

  async vote(input: VoteInput, userId: string): Promise<VoteResponseDto> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const target = await this.lockTarget(
        connection,
        input.target_type,
        input.target_id,
        userId,
      );
      // A comment's community is its post's (findTarget's two hops). Ban
      // first, then rules: a banned user is told the actionable fact.
      await this.bans.assertNotBannedOrThrow(
        userId,
        target.communityId,
        connection,
      );
      // Voting is participation: gated on the target's community rules,
      // after the 404 for an unknown target, on the transaction's connection.
      await this.ruleAcceptance.assertAcceptedOrThrow(
        userId,
        target.communityId,
        connection,
      );
      // A vote is directed at the content's author: refused when either has
      // blocked the other, after the 404 and the rule gate.
      await this.blocks.assertNotBlockedOrThrow(
        userId,
        target.authorId,
        connection,
      );
      // Removed content takes no new votes. Withdrawing a vote (DELETE)
      // and reading one's own vote stay possible.
      if (target.removed) {
        throw new ConflictException(
          input.target_type === 'post'
            ? 'This post was removed by a moderator and cannot be voted on'
            : 'This comment was removed by a moderator and cannot be voted on',
        );
      }

      await connection.execute<ResultSetHeader>(
        'INSERT INTO votes (id, user_id, target_type, target_id, value) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [randomUUID(), userId, input.target_type, input.target_id, input.value],
      );
      await this.recomputeRanking(
        connection,
        input.target_type,
        input.target_id,
      );

      const [votes] = await connection.execute<VoteRow[]>(
        'SELECT id, user_id, target_type, target_id, value, created_at FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        [userId, input.target_type, input.target_id],
      );
      const vote = votes[0];
      if (!vote) {
        throw new Error('Saved vote could not be retrieved');
      }

      const score = await this.score(
        connection,
        input.target_type,
        input.target_id,
      );

      await connection.commit();

      return {
        id: vote.id,
        user_id: vote.user_id,
        target_type: vote.target_type,
        target_id: vote.target_id,
        value: vote.value,
        created_at: new Date(vote.created_at).toISOString(),
        score,
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

  // DELETE /posts/:id/vote, DELETE /comments/:id/vote. Same transaction
  // shape as vote(): the target is locked first, so the returned score is
  // consistent with the deletion. Idempotent: without a vote nothing is
  // deleted and the current score is returned.
  // Deliberately NOT gated on rule acceptance or on blocks: withdrawing a vote removes
  // participation rather than adding it, and gating it would leave a user who
  // declines new rules with votes they cannot retract.
  async withdraw(
    targetType: VoteTarget,
    targetId: string,
    userId: string,
  ): Promise<VoteScoreDto> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;
      await this.lockTarget(connection, targetType, targetId);

      await connection.execute<ResultSetHeader>(
        'DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?',
        [userId, targetType, targetId],
      );
      await this.recomputeRanking(connection, targetType, targetId);
      const score = await this.score(connection, targetType, targetId);

      await connection.commit();
      return { score };
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  // GET /posts/:id/vote, GET /comments/:id/vote: the caller's own vote, or
  // null, and the score. A read: no transaction, no lock, no rule gate. The
  // own-vote lookup is bound to userId, so it never returns another user's
  // vote; it is served by unique_user_target, the score by idx_votes_target.
  async state(
    targetType: VoteTarget,
    targetId: string,
    userId: string,
  ): Promise<VoteStateDto> {
    await this.findTarget(this.pool, targetType, targetId, false, userId);
    const [own] = await this.pool.execute<
      (RowDataPacket & { value: number })[]
    >(OWN_VOTE_SQL, [userId, targetType, targetId]);
    const score = await this.score(this.pool, targetType, targetId);
    return {
      value: own[0] ? (Number(own[0].value) as -1 | 1) : null,
      score,
    };
  }

  // The target's stored counters and ranks (migration 034), recomputed from
  // the votes table rather than adjusted by a delta, so a repeat vote, a
  // changed vote and a withdrawal without a vote all leave them exact. On the
  // vote's connection, after lockTarget: concurrent votes on one target
  // serialise on its row lock and commit consistent values.
  private async recomputeRanking(
    connection: PoolConnection,
    targetType: VoteTarget,
    targetId: string,
  ): Promise<void> {
    await connection.execute<ResultSetHeader>(
      targetType === 'post'
        ? RECOMPUTE_POST_RANKING_SQL
        : RECOMPUTE_COMMENT_RANKING_SQL,
      [targetId, targetId, targetId],
    );
  }

  private async score(
    executor: Executor,
    targetType: VoteTarget,
    targetId: string,
  ): Promise<number> {
    const [scores] = await executor.execute<
      (RowDataPacket & { score: number | string })[]
    >(SCORE_SQL, [targetType, targetId]);
    return Number(scores[0]?.score ?? 0);
  }

  // Locks the target row and returns its community. A comment's community is
  // its post's; only the comment row is locked, not the post.
  private lockTarget(
    connection: PoolConnection,
    targetType: VoteTarget,
    targetId: string,
    viewerId?: string,
  ): Promise<VoteTargetState> {
    return this.findTarget(connection, targetType, targetId, true, viewerId);
  }

  // The one target lookup: 404 for an unknown target or one in a deleted
  // community, resolving a comment's community through comments → posts.
  // With a viewer, also 404 in a private community the viewer is not a
  // member of: voting and reading a vote need read access. Withdrawing a
  // vote passes none, so leaving a private community never strands one.
  private async findTarget(
    executor: Executor,
    targetType: VoteTarget,
    targetId: string,
    lock: boolean,
    viewerId?: string,
  ): Promise<VoteTargetState> {
    const community =
      viewerId === undefined
        ? visibleCommunitySql('posts.community_id')
        : readableCommunitySql('posts.community_id');
    const [targets] = await executor.execute<
      (RowDataPacket & {
        id: string;
        community_id: string;
        author_id: string;
        removed?: number | string | boolean | null;
      })[]
    >(
      targetType === 'post'
        ? `SELECT id, community_id, author_id, removed_at IS NOT NULL AS removed FROM posts WHERE id = ? AND ${community}${lock ? ' FOR UPDATE' : ''}`
        : `SELECT comments.id, posts.community_id, comments.author_id,
             (comments.removed_at IS NOT NULL OR posts.removed_at IS NOT NULL) AS removed
           FROM comments
           INNER JOIN posts ON posts.id = comments.post_id
           WHERE comments.id = ? AND ${community}${
             lock ? '\n           FOR UPDATE OF comments' : ''
           }`,
      viewerId === undefined ? [targetId] : [targetId, viewerId],
    );

    const target = targets[0];
    if (!target) {
      throw new NotFoundException(
        targetType === 'post' ? 'Post not found' : 'Comment not found',
      );
    }
    return {
      communityId: target.community_id,
      authorId: target.author_id,
      removed: isSqlTrue(target.removed ?? 0),
    };
  }
}
