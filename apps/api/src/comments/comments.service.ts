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
import type { NotificationEntry } from '../notifications/notification-metadata';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateCommentDto } from './dto/create-comment.dto';

interface CommentRow extends RowDataPacket {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  content: string;
  created_at: Date | string;
}

const MAX_COMMENTS_PER_THREAD = 500;

export interface CommentDto {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  content: string;
  created_at: string;
  replies: CommentDto[];
}

export interface CommentThreadDto {
  post_id: string;
  comments: CommentDto[];
}

@Injectable()
export class CommentsService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly notifications: NotificationsService,
  ) {}

  async findThread(postId: string): Promise<CommentThreadDto> {
    await this.ensurePostExists(postId);
    const [rows] = await this.pool.execute<CommentRow[]>(
      'SELECT id, post_id, author_id, parent_id, content, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
      [postId, MAX_COMMENTS_PER_THREAD + 1],
    );
    if (rows.length > MAX_COMMENTS_PER_THREAD) {
      throw new PayloadTooLargeException(
        `Comment threads are limited to ${MAX_COMMENTS_PER_THREAD} comments`,
      );
    }

    const nodes = new Map<string, CommentDto>();
    for (const row of rows) {
      nodes.set(row.id, {
        id: row.id,
        post_id: row.post_id,
        author_id: row.author_id,
        parent_id: row.parent_id,
        content: row.content,
        created_at: new Date(row.created_at).toISOString(),
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
        'SELECT id, author_id, community_id, title FROM posts WHERE id = ? LIMIT 1',
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

  async remove(id: string, authorId: string): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE comments FROM comments
       INNER JOIN posts ON posts.id = comments.post_id
       WHERE comments.id = ? AND (
         comments.author_id = ? OR EXISTS (
           SELECT 1 FROM communities
           WHERE communities.id = posts.community_id
             AND (
               communities.creator_id = ? OR EXISTS (
                 SELECT 1 FROM community_moderators
                 WHERE community_id = communities.id AND user_id = ?
               )
             )
         )
       )`,
      [id, authorId, authorId, authorId],
    );
    if (result.affectedRows === 0) {
      const [comments] = await this.pool.execute<
        (RowDataPacket & { id: string })[]
      >('SELECT id FROM comments WHERE id = ? LIMIT 1', [id]);
      if (!comments[0]) {
        throw new NotFoundException('Comment not found');
      }
      throw new ForbiddenException(
        'You can only delete your own comments or moderate this community',
      );
    }
  }

  private async ensurePostExists(postId: string): Promise<void> {
    const [posts] = await this.pool.execute<(RowDataPacket & { id: string })[]>(
      'SELECT id FROM posts WHERE id = ? LIMIT 1',
      [postId],
    );
    if (!posts[0]) {
      throw new NotFoundException('Post not found');
    }
  }
}
