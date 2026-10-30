import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import { readPositiveInteger } from '../common/read-positive-integer';
import { NotificationsService } from '../notifications/notifications.service';
import { CreatePostDto } from './dto/create-post.dto';
import { ListPostsDto } from './dto/list-posts.dto';

interface PostRow extends RowDataPacket {
  id: string;
  title: string;
  content: string | null;
  type: 'text' | 'link' | 'media';
  author_id: string;
  community_id: string;
  created_at: Date | string;
}

interface RemovablePostRow extends RowDataPacket {
  id: string;
  author_id: string;
  community_id: string;
  title: string;
  can_moderate: number | string | boolean;
}

export interface PostDto {
  id: string;
  title: string;
  content: string | null;
  type: 'text' | 'link' | 'media';
  author_id: string;
  community_id: string;
  created_at: string;
}

export interface PostListDto {
  items: PostDto[];
  page: number;
  limit: number;
  total: number;
  sort: 'new';
}

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);
  // The most community_post rows one post may write inside its request's
  // transaction. Above it the fan-out is skipped, never truncated.
  private readonly fanOutMax = readPositiveInteger(
    'NOTIFICATION_FANOUT_MAX',
    5000,
  );

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly notifications: NotificationsService,
  ) {}

  async findAll(query: ListPostsDto): Promise<PostListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const where = query.community_id ? ' WHERE community_id = ?' : '';
    const values: (string | number)[] = query.community_id
      ? [query.community_id]
      : [];
    const [posts] = await this.pool.execute<PostRow[]>(
      `SELECT id, title, content, type, author_id, community_id, created_at FROM posts${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number })[]
    >(`SELECT COUNT(*) AS total FROM posts${where}`, values);

    return {
      items: posts.map((post) => this.toDto(post)),
      page,
      limit,
      total: countRows[0].total,
      sort: 'new',
    };
  }

  // The post and its community_post fan-out commit together: a failed
  // notification write rolls the post back (see NotificationsService).
  async create(input: CreatePostDto, authorId: string): Promise<PostDto> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const [communities] = await connection.execute<
        (RowDataPacket & { id: string })[]
      >('SELECT id FROM communities WHERE id = ? LIMIT 1', [
        input.community_id,
      ]);

      if (!communities[0]) {
        throw new NotFoundException('Community not found');
      }

      const id = randomUUID();
      await connection.execute<ResultSetHeader>(
        'INSERT INTO posts (id, title, content, type, author_id, community_id) VALUES (?, ?, ?, ?, ?, ?)',
        [
          id,
          input.title.trim(),
          input.content.trim(),
          input.type,
          authorId,
          input.community_id,
        ],
      );

      const [posts] = await connection.execute<PostRow[]>(
        'SELECT id, title, content, type, author_id, community_id, created_at FROM posts WHERE id = ? LIMIT 1',
        [id],
      );
      const post = posts[0];

      if (!post) {
        throw new Error('Created post could not be retrieved');
      }

      const fanOut = await this.notifications.recordCommunityPost(
        connection,
        {
          type: 'community_post',
          actorId: authorId,
          subjectType: 'post',
          subjectId: post.id,
          communityId: post.community_id,
          metadata: { post_title: post.title },
        },
        this.fanOutMax,
      );
      if (!fanOut.written && fanOut.recipients > this.fanOutMax) {
        this.logger.warn(
          `Skipped community_post notifications for community ${post.community_id}: ${fanOut.recipients} eligible recipients exceed NOTIFICATION_FANOUT_MAX (${this.fanOutMax})`,
        );
      }

      await connection.commit();
      return this.toDto(post);
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async findOne(id: string): Promise<PostDto> {
    const [posts] = await this.pool.execute<PostRow[]>(
      'SELECT id, title, content, type, author_id, community_id, created_at FROM posts WHERE id = ? LIMIT 1',
      [id],
    );
    const post = posts[0];

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    return this.toDto(post);
  }

  // The author, the community creator or a community moderator may delete a
  // post. The row is locked and read first so the service, not a WHERE
  // clause, decides which of those applies: a removal by anyone but the
  // author notifies the author (content_removed) inside the same
  // transaction, from a snapshot taken before the row is gone.
  async remove(id: string, actorId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const [posts] = await connection.execute<RemovablePostRow[]>(
        `SELECT posts.id, posts.author_id, posts.community_id, posts.title,
           ${canModerateCommunitySql('posts.community_id')} AS can_moderate
         FROM posts
         WHERE posts.id = ? LIMIT 1 FOR UPDATE`,
        [actorId, actorId, id],
      );
      const post = posts[0];
      if (!post) {
        throw new NotFoundException('Post not found');
      }
      const isAuthor = post.author_id === actorId;
      if (!isAuthor && !isSqlTrue(post.can_moderate)) {
        throw new ForbiddenException(
          'You can only delete your own posts or moderate this community',
        );
      }

      await connection.execute<ResultSetHeader>(
        'DELETE FROM posts WHERE id = ?',
        [id],
      );
      if (!isAuthor) {
        await this.notifications.record(connection, {
          recipientId: post.author_id,
          type: 'content_removed',
          actorId: null,
          subjectType: 'post',
          subjectId: post.id,
          communityId: post.community_id,
          metadata: { post_title: post.title },
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

  private toDto(post: PostRow): PostDto {
    return {
      id: post.id,
      title: post.title,
      content: post.content,
      type: post.type,
      author_id: post.author_id,
      community_id: post.community_id,
      created_at: new Date(post.created_at).toISOString(),
    };
  }
}
