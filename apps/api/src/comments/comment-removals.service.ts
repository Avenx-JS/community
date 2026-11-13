import { closeCommunityReports } from '../reports/community-report-review';
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
import type { RemoveContentDto } from '../common/remove-content.dto';
import {
  ADMIN_REMOVAL_LOCKED,
  toRemovalState,
  type RemovalStateDto,
  type RemovalStateRow,
} from '../common/removed-content';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommentsService, type CommentReplyDto } from './comments.service';

interface RemovableCommentRow extends RowDataPacket {
  id: string;
  post_id: string;
  author_id: string;
  content: string;
  community_id: string;
  removed_at: Date | string | null;
  // Absent from older fakes: read through isSqlTrue.
  removed_by_admin?: number | string | boolean | null;
  post_removed_at: Date | string | null;
  can_moderate: number | string | boolean;
}

export type RemovedCommentDto = CommentReplyDto & RemovalStateDto;

// POST /comments/:id/remove and /restore: a moderator's reversible removal,
// as PostsService.removeContent and restore are for posts. DELETE
// /comments/:id stays the author's own hard delete. Community creator or
// moderator only; the author is refused (they have DELETE). The removal
// keeps the row and its replies; the thread shows it as a tombstone to
// everyone but its reviewers. The author is notified with a null actor and
// the content excerpt only, never the reason or the moderator (#44). One
// log entry per route, with the reason on removal, in the same transaction.
@Injectable()
export class CommentRemovalService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly comments: CommentsService,
    private readonly notifications: NotificationsService,
    private readonly moderationLog: CommunityModerationLogService,
  ) {}

  async remove(
    id: string,
    input: RemoveContentDto,
    actorId: string,
  ): Promise<RemovedCommentDto> {
    return this.inTransaction((connection) =>
      this.removeOn(connection, id, input, actorId),
    );
  }

  // The removal itself, on the caller's transaction: POST /comments/:id/remove
  // and POST /communities/:name/reports/:id/remove both run it. Closes the
  // comment's open community reports as removed.
  async removeOn(
    connection: PoolConnection,
    id: string,
    input: RemoveContentDto,
    actorId: string,
  ): Promise<RemovedCommentDto> {
    const comment = await this.lockForRemoval(connection, id, actorId);
    if (comment.removed_at !== null) {
      throw new ConflictException('This comment is already removed');
    }
    const reason = input.reason ?? null;
    await connection.execute<ResultSetHeader>(
      'UPDATE comments SET removed_at = UTC_TIMESTAMP(), removed_by = ?, removal_reason = ? WHERE id = ? AND removed_at IS NULL',
      [actorId, reason, id],
    );
    // Always true under this route's authorisation; kept so the rule
    // "an author's own act notifies nobody" is expressed in one place.
    if (comment.author_id !== actorId) {
      await this.notifications.record(connection, {
        recipientId: comment.author_id,
        type: 'content_removed',
        actorId: null,
        subjectType: 'comment',
        subjectId: comment.id,
        communityId: comment.community_id,
        metadata: { excerpt: comment.content },
      });
    }
    await this.moderationLog.record(connection, {
      actorId,
      communityId: comment.community_id,
      action: 'comment_removed',
      targetType: 'comment',
      targetId: id,
      ...(reason === null ? {} : { metadata: { reason } }),
    });
    await closeCommunityReports(connection, this.moderationLog, {
      status: 'removed',
      actorId,
      communityId: comment.community_id,
      targetType: 'comment',
      targetId: id,
    });

    const flat = await this.comments.readFlat(connection, id);
    const [state] = await connection.execute<
      (RowDataPacket & RemovalStateRow)[]
    >(
      'SELECT removed_at, removed_by, removal_reason, removed_by_admin FROM comments WHERE id = ? LIMIT 1',
      [id],
    );
    return { ...flat, ...toRemovalState(state[0]) };
  }

  // 409 unless removed, and 409 naming the post when the post itself is
  // removed: restoring the comment would succeed into a thread nobody but
  // reviewers can see. No notification (a new notifications.type value
  // would need a migration; a follow-up).
  async restore(id: string, actorId: string): Promise<CommentReplyDto> {
    return this.inTransaction(async (connection) => {
      const comment = await this.lockForRemoval(connection, id, actorId);
      if (comment.removed_at === null) {
        throw new ConflictException('This comment is not removed');
      }
      if (isSqlTrue(comment.removed_by_admin ?? false)) {
        throw new ForbiddenException(ADMIN_REMOVAL_LOCKED);
      }
      if (comment.post_removed_at !== null) {
        throw new ConflictException(
          `The post of this comment (${comment.post_id}) is removed; restore the post first`,
        );
      }
      await connection.execute<ResultSetHeader>(
        'UPDATE comments SET removed_at = NULL, removed_by = NULL, removal_reason = NULL WHERE id = ? AND removed_at IS NOT NULL',
        [id],
      );
      await this.moderationLog.record(connection, {
        actorId,
        communityId: comment.community_id,
        action: 'comment_restored',
        targetType: 'comment',
        targetId: id,
      });
      return this.comments.readFlat(connection, id);
    });
  }

  private async lockForRemoval(
    connection: PoolConnection,
    id: string,
    actorId: string,
  ): Promise<RemovableCommentRow> {
    const [rows] = await connection.execute<RemovableCommentRow[]>(
      `SELECT comments.id, comments.post_id, comments.author_id, comments.content,
         posts.community_id, comments.removed_at, comments.removed_by_admin, posts.removed_at AS post_removed_at,
         ${canModerateCommunitySql('posts.community_id')} AS can_moderate
       FROM comments
       INNER JOIN posts ON posts.id = comments.post_id
       WHERE comments.id = ? AND ${visibleCommunitySql('posts.community_id')}
       LIMIT 1 FOR UPDATE OF comments`,
      [actorId, actorId, id],
    );
    const comment = rows[0];
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }
    if (!isSqlTrue(comment.can_moderate)) {
      throw new ForbiddenException(
        comment.author_id === actorId
          ? 'Moderators remove comments; authors delete their own with DELETE /comments/:id'
          : 'Only the community creator and moderators can remove or restore comments',
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
