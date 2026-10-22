import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { CreateCommentDto } from './dto/create-comment.dto';

interface CommentRow extends RowDataPacket {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  content: string;
  created_at: Date | string;
}

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
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async findThread(postId: string): Promise<CommentThreadDto> {
    await this.ensurePostExists(postId);
    const [rows] = await this.pool.execute<CommentRow[]>(
      'SELECT id, post_id, author_id, parent_id, content, created_at FROM comments WHERE post_id = ? ORDER BY created_at ASC, id ASC',
      [postId],
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

  async create(
    postId: string,
    input: CreateCommentDto,
    authorId: string,
  ): Promise<CommentDto> {
    await this.ensurePostExists(postId);
    const parentId = input.parent_id ?? null;

    if (parentId !== null) {
      const [parents] = await this.pool.execute<
        (RowDataPacket & { id: string })[]
      >('SELECT id FROM comments WHERE id = ? AND post_id = ? LIMIT 1', [
        parentId,
        postId,
      ]);
      if (!parents[0]) {
        throw new NotFoundException('Parent comment not found for this post');
      }
    }

    const id = randomUUID();
    await this.pool.execute<ResultSetHeader>(
      'INSERT INTO comments (id, post_id, author_id, parent_id, content) VALUES (?, ?, ?, ?, ?)',
      [id, postId, authorId, parentId, input.content.trim()],
    );

    const [comments] = await this.pool.execute<CommentRow[]>(
      'SELECT id, post_id, author_id, parent_id, content, created_at FROM comments WHERE id = ? LIMIT 1',
      [id],
    );
    const comment = comments[0];
    if (!comment) {
      throw new Error('Created comment could not be retrieved');
    }

    return {
      id: comment.id,
      post_id: comment.post_id,
      author_id: comment.author_id,
      parent_id: comment.parent_id,
      content: comment.content,
      created_at: new Date(comment.created_at).toISOString(),
      replies: [],
    };
  }

  async remove(id: string, authorId: string): Promise<void> {
    const [comments] = await this.pool.execute<
      (RowDataPacket & { author_id: string })[]
    >('SELECT author_id FROM comments WHERE id = ? LIMIT 1', [id]);
    const comment = comments[0];
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }
    if (comment.author_id !== authorId) {
      throw new ForbiddenException('You can only delete your own comments');
    }

    const [result] = await this.pool.execute<ResultSetHeader>(
      'DELETE FROM comments WHERE id = ? AND author_id = ?',
      [id, authorId],
    );
    if (result.affectedRows === 0) {
      throw new NotFoundException('Comment not found');
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
