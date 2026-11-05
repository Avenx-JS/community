import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import { activeCommunitySql } from '../common/community-visibility';
import type { NotificationEntry } from '../notifications/notification-metadata';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import type {
  CommentListSort,
  ListCommentRepliesDto,
} from './dto/list-comment-replies.dto';
import { loadVoteScores } from '../votes/vote-scores';

interface CommentRow extends RowDataPacket {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  content: string;
  created_at: Date | string;
}

interface RemovableCommentRow extends RowDataPacket {
  id: string;
  author_id: string;
  content: string;
  community_id: string;
  can_moderate: number | string | boolean;
}

interface CommentReplyRow extends RowDataPacket {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  content: string;
  created_at: Date | string;
  edited_at: Date | string | null;
}

export const MAX_COMMENTS_PER_THREAD = 500;

// The 413 of the tree route names the way out: the two paginated routes
// together reach every comment of a thread of any size.
export const THREAD_TOO_LARGE_MESSAGE =
  `Comment threads are limited to ${MAX_COMMENTS_PER_THREAD} comments; ` +
  'page through GET /posts/:postId/comments/top-level and ' +
  'GET /comments/:id/replies instead';

// Columns of a flat listed comment. No replies: see CommentReplyDto.
const COMMENT_REPLY_COLUMNS =
  'id, post_id, parent_id, author_id, content, created_at, edited_at';

// Comments removed by moderation are never listed by the paginated routes.
const VISIBLE_COMMENT_SQL = 'removed_at IS NULL';

const commentListOrder = (sort: CommentListSort): string =>
  sort === 'new'
    ? 'ORDER BY created_at DESC, id DESC'
    : 'ORDER BY created_at ASC, id ASC';

export interface CommentDto {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  content: string;
  created_at: string;
  // Sum of all vote values; 0 without votes.
  score: number;
  replies: CommentDto[];
}

export interface CommentThreadDto {
  post_id: string;
  comments: CommentDto[];
}

// One comment of a paginated listing (GET /comments/:id/replies,
// GET /posts/:postId/comments/top-level). Deliberately flat: a reply_count
// instead of a replies array, because a page whose items carried their
// subtrees would be as unbounded as the tree route it is the escape from. A
// client recurses through GET /comments/:id/replies when reply_count > 0.
export interface CommentReplyDto {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  content: string;
  created_at: string;
  edited_at: string | null;
  reply_count: number;
  score: number;
}

export interface CommentReplyListDto {
  items: CommentReplyDto[];
  page: number;
  limit: number;
  total: number;
  sort: CommentListSort;
}

@Injectable()
export class CommentsService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly notifications: NotificationsService,
    private readonly ruleAcceptance: CommunityRuleAcceptanceService,
  ) {}

  async findThread(postId: string): Promise<CommentThreadDto> {
    await this.ensurePostExists(postId);
    const [rows] = await this.pool.execute<CommentRow[]>(
      'SELECT id, post_id, author_id, parent_id, content, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
      [postId, MAX_COMMENTS_PER_THREAD + 1],
    );
    if (rows.length > MAX_COMMENTS_PER_THREAD) {
      throw new PayloadTooLargeException(THREAD_TOO_LARGE_MESSAGE);
    }

    // One grouped aggregate for the whole (bounded) thread.
    const scores = await loadVoteScores(
      this.pool,
      'comment',
      rows.map((row) => row.id),
    );
    const nodes = new Map<string, CommentDto>();
    for (const row of rows) {
      nodes.set(row.id, {
        id: row.id,
        post_id: row.post_id,
        author_id: row.author_id,
        parent_id: row.parent_id,
        content: row.content,
        created_at: new Date(row.created_at).toISOString(),
        score: scores.get(row.id) ?? 0,
        replies: [],
      });
    }

    const comments: CommentDto[] = [];
    for (const row of rows) {
      const comment = nodes.get(row.id);
      if (!comment) {
        throw new Error(`Comment row ${row.id} could not be mapped`);
      }
      if (row.parent_id === null) {
        comments.push(comment);
        continue;
      }

      const parent = nodes.get(row.parent_id);
      if (parent) {
        parent.replies.push(comment);
      } else {
        throw new Error(
          `Comment ${row.id} has a parent missing from post ${postId}`,
        );
      }
    }

    return { post_id: postId, comments };
  }

  // Direct, visible children of one comment, a page at a time. The parent
  // itself may be removed: removing a comment hides it, not the discussion
  // beneath it, so its replies stay readable here. A comment on a post in a
  // deleted community is not found.
  async findReplies(
    commentId: string,
    query: ListCommentRepliesDto,
  ): Promise<CommentReplyListDto> {
    const [parents] = await this.pool.execute<
      (RowDataPacket & { id: string })[]
    >(
      `SELECT comments.id FROM comments
       INNER JOIN posts ON posts.id = comments.post_id
       WHERE comments.id = ? AND ${activeCommunitySql('posts.community_id')}
       LIMIT 1`,
      [commentId],
    );
    if (!parents[0]) {
      throw new NotFoundException('Comment not found');
    }
    return this.listComments(
      `parent_id = ? AND ${VISIBLE_COMMENT_SQL}`,
      [commentId],
      query,
    );
  }

  // The post's visible root comments, a page at a time. With findReplies,
  // every comment of a thread of any size is reachable.
  async findTopLevel(
    postId: string,
    query: ListCommentRepliesDto,
  ): Promise<CommentReplyListDto> {
    await this.ensurePostExists(postId);
    return this.listComments(
      `post_id = ? AND parent_id IS NULL AND ${VISIBLE_COMMENT_SQL}`,
      [postId],
      query,
    );
  }

  // Three statements whatever the page size: the page, its total, and one
  // grouped reply count over the page's ids (skipped for an empty page).
  private async listComments(
    where: string,
    values: string[],
    query: ListCommentRepliesDto,
  ): Promise<CommentReplyListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sort = query.sort ?? 'oldest';
    const offset = (page - 1) * limit;

    const [rows] = await this.pool.execute<CommentReplyRow[]>(
      `SELECT ${COMMENT_REPLY_COLUMNS} FROM comments WHERE ${where} ${commentListOrder(sort)} LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total FROM comments WHERE ${where}`, values);
    const ids = rows.map((row) => row.id);
    const replyCounts = await this.countReplies(ids);
    const scores = await loadVoteScores(this.pool, 'comment', ids);

    return {
      items: rows.map((row) => ({
        id: row.id,
        post_id: row.post_id,
        parent_id: row.parent_id,
        author_id: row.author_id,
        content: row.content,
        created_at: new Date(row.created_at).toISOString(),
        edited_at:
          row.edited_at === null || row.edited_at === undefined
            ? null
            : new Date(row.edited_at).toISOString(),
        reply_count: replyCounts.get(row.id) ?? 0,
        score: scores.get(row.id) ?? 0,
      })),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
      sort,
    };
  }

  // Visible direct replies per comment id: one grouped query over the
  // page's ids, not a subquery per row. An id absent from the result has
  // no replies.
  private async countReplies(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const [rows] = await this.pool.execute<
      (RowDataPacket & { parent_id: string; reply_count: number | string })[]
    >(
      `SELECT parent_id, COUNT(*) AS reply_count FROM comments WHERE parent_id IN (${ids.map(() => '?').join(', ')}) AND ${VISIBLE_COMMENT_SQL} GROUP BY parent_id`,
      ids,
    );
    return new Map(rows.map((row) => [row.parent_id, Number(row.reply_count)]));
  }

  // Exactly one notification per comment: a top-level comment notifies the
  // post author (post_comment), a reply notifies the parent comment's author
  // (comment_reply) and never the post author. It commits with the comment,
  // so a failed notification write rolls the comment back. Self-notification
  // is suppressed by NotificationsService.
  async create(
    postId: string,
    input: CreateCommentDto,
    authorId: string,
  ): Promise<CommentDto> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const [posts] = await connection.execute<
        (RowDataPacket & {
          id: string;
          author_id: string;
          community_id: string;
          title: string;
        })[]
      >(
        `SELECT id, author_id, community_id, title FROM posts WHERE id = ? AND ${activeCommunitySql('posts.community_id')} LIMIT 1`,
        [postId],
      );
      const post = posts[0];
      if (!post) {
        throw new NotFoundException('Post not found');
      }

      const parentId = input.parent_id ?? null;
      let parentAuthorId: string | null = null;
      if (parentId !== null) {
        const [parents] = await connection.execute<
          (RowDataPacket & { id: string; author_id: string })[]
        >(
          'SELECT id, author_id FROM comments WHERE id = ? AND post_id = ? LIMIT 1',
          [parentId, postId],
        );
        if (!parents[0]) {
          throw new NotFoundException('Parent comment not found for this post');
        }
        parentAuthorId = parents[0].author_id;
      }
      await this.ruleAcceptance.assertAcceptedOrThrow(
        authorId,
        post.community_id,
        connection,
      );

      const id = randomUUID();
      await connection.execute<ResultSetHeader>(
        'INSERT INTO comments (id, post_id, author_id, parent_id, content) VALUES (?, ?, ?, ?, ?)',
        [id, postId, authorId, parentId, input.content.trim()],
      );

      const [comments] = await connection.execute<CommentRow[]>(
        'SELECT id, post_id, author_id, parent_id, content, created_at FROM comments WHERE id = ? LIMIT 1',
        [id],
      );
      const comment = comments[0];
      if (!comment) {
        throw new Error('Created comment could not be retrieved');
      }

      const notification: NotificationEntry =
        parentId === null || parentAuthorId === null
          ? {
              recipientId: post.author_id,
              type: 'post_comment',
              actorId: authorId,
              subjectType: 'comment',
              subjectId: comment.id,
              communityId: post.community_id,
              metadata: {
                post_id: post.id,
                post_title: post.title,
                excerpt: comment.content,
              },
            }
          : {
              recipientId: parentAuthorId,
              type: 'comment_reply',
              actorId: authorId,
              subjectType: 'comment',
              subjectId: comment.id,
              communityId: post.community_id,
              metadata: {
                post_id: post.id,
                parent_comment_id: parentId,
                excerpt: comment.content,
              },
            };
      await this.notifications.record(connection, notification);

      await connection.commit();
      return {
        id: comment.id,
        post_id: comment.post_id,
        author_id: comment.author_id,
        parent_id: comment.parent_id,
        content: comment.content,
        created_at: new Date(comment.created_at).toISOString(),
        // A new comment has no votes yet.
        score: 0,
        replies: [],
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

  // The author, the community creator or a community moderator may delete a
  // comment (its replies go with it by cascade). The comment row is locked
  // and read first so the service decides which of those applies; a removal
  // by anyone but the author notifies the author (content_removed) inside the
  // same transaction. Authors of cascaded replies are not notified.
  async remove(id: string, actorId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const [comments] = await connection.execute<RemovableCommentRow[]>(
        `SELECT comments.id, comments.author_id, comments.content,
           posts.community_id,
           ${canModerateCommunitySql('posts.community_id')} AS can_moderate
         FROM comments
         INNER JOIN posts ON posts.id = comments.post_id
         WHERE comments.id = ? AND ${activeCommunitySql('posts.community_id')}
         LIMIT 1 FOR UPDATE OF comments`,
        [actorId, actorId, id],
      );
      const comment = comments[0];
      if (!comment) {
        throw new NotFoundException('Comment not found');
      }
      const isAuthor = comment.author_id === actorId;
      if (!isAuthor && !isSqlTrue(comment.can_moderate)) {
        throw new ForbiddenException(
          'You can only delete your own comments or moderate this community',
        );
      }

      await connection.execute<ResultSetHeader>(
        'DELETE FROM comments WHERE id = ?',
        [id],
      );
      if (!isAuthor) {
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

      await connection.commit();
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  private async ensurePostExists(postId: string): Promise<void> {
    const [posts] = await this.pool.execute<(RowDataPacket & { id: string })[]>(
      `SELECT id FROM posts WHERE id = ? AND ${activeCommunitySql('posts.community_id')} LIMIT 1`,
      [postId],
    );
    if (!posts[0]) {
      throw new NotFoundException('Post not found');
    }
  }
}
