import {
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
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import { visibleCommunitySql } from '../common/community-visibility';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { CommentsService, type CommentReplyDto } from './comments.service';

interface LockableCommentRow extends RowDataPacket {
  id: string;
  community_id: string;
  locked_at: Date | string | null;
  removed_at: Date | string | null;
  can_moderate: number | string | boolean;
}

// POST and DELETE /comments/:id/lock. A comment lock closes that comment's
// whole subtree to new replies, at any depth; CommentsService.create
// enforces it with a recursive ancestor check (PARENT_WITH_ANCESTRY_SQL).
// A service of its own, beside CommentsService, because it needs the
// moderation log. Same rules as PostsService.lock: community creator or
// moderator only (authorship is not enough), idempotent without refreshing
// locked_at, 409 for removed content, one log entry per actual change inside
// the transaction.
@Injectable()
export class CommentLocksService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly comments: CommentsService,
    private readonly moderationLog: CommunityModerationLogService,
  ) {}

  async lock(id: string, actorId: string): Promise<CommentReplyDto> {
    return this.inTransaction(async (connection) => {
      const comment = await this.lockForModeration(connection, id, actorId);
      if (comment.removed_at !== null) {
        throw new ConflictException('A removed comment cannot be locked');
      }
      const [result] = await connection.execute<ResultSetHeader>(
        'UPDATE comments SET locked_at = UTC_TIMESTAMP(), locked_by = ? WHERE id = ? AND locked_at IS NULL',
        [actorId, id],
      );
      // affectedRows 0: already locked, so nothing changed or is logged.
      if (result.affectedRows === 1) {
        await this.moderationLog.record(connection, {
          actorId,
          communityId: comment.community_id,
          action: 'comment_locked',
          targetType: 'comment',
          targetId: id,
        });
      }
      return this.comments.readFlat(connection, id);
    });
  }

  async unlock(id: string, actorId: string): Promise<void> {
    await this.inTransaction(async (connection) => {
      const comment = await this.lockForModeration(connection, id, actorId);
      if (comment.removed_at !== null) {
        throw new ConflictException('A removed comment cannot be unlocked');
      }
      const [result] = await connection.execute<ResultSetHeader>(
        'UPDATE comments SET locked_at = NULL, locked_by = NULL WHERE id = ? AND locked_at IS NOT NULL',
        [id],
      );
      if (result.affectedRows === 1) {
        await this.moderationLog.record(connection, {
          actorId,
          communityId: comment.community_id,
          action: 'comment_unlocked',
          targetType: 'comment',
          targetId: id,
        });
      }
    });
  }

  // Locks the comment row and resolves its community through comments →
  // posts, as VotesService does: 404 for an unknown comment or one in a
  // deleted community, 403 unless the actor created or moderates it.
  private async lockForModeration(
    connection: PoolConnection,
    id: string,
    actorId: string,
  ): Promise<LockableCommentRow> {
    const [comments] = await connection.execute<LockableCommentRow[]>(
      `SELECT comments.id, posts.community_id, comments.locked_at, comments.removed_at,
         ${canModerateCommunitySql('posts.community_id')} AS can_moderate
       FROM comments
       INNER JOIN posts ON posts.id = comments.post_id
       WHERE comments.id = ? AND ${visibleCommunitySql('posts.community_id')}
       LIMIT 1 FOR UPDATE OF comments`,
      [actorId, actorId, id],
    );
    const comment = comments[0];
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }
    if (!isSqlTrue(comment.can_moderate)) {
      throw new ForbiddenException(
        'Only the community creator and moderators can lock or unlock comments',
      );
    }
    return comment;
  }

  private async inTransaction<T>(
    work: (connection: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
