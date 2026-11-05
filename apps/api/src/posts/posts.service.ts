import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
import { activeCommunitySql } from '../common/community-visibility';
import { readPositiveInteger } from '../common/read-positive-integer';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
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
  pinned_at: Date | string | null;
  pinned_by: string | null;
}

// Every column of a post DTO, in DTO order.
const POST_COLUMNS =
  'id, title, content, type, author_id, community_id, created_at, pinned_at, pinned_by';

interface PinnablePostRow extends RowDataPacket {
  id: string;
  community_id: string;
  pinned_at: Date | string | null;
  removed_at: Date | string | null;
  can_moderate: number | string | boolean;
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
  pinned_at: string | null;
  // NULL on a pinned post once the pinning moderator's account is deleted.
  pinned_by: string | null;
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
  // The most posts one community may have pinned at once.
  private readonly pinnedPostsMax = readPositiveInteger(
    'COMMUNITY_PINNED_POSTS_MAX',
    5,
  );

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly notifications: NotificationsService,
    private readonly ruleAcceptance: CommunityRuleAcceptanceService,
    private readonly moderationLog: CommunityModerationLogService,
  ) {}

  async findAll(query: ListPostsDto): Promise<PostListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    // Posts in a deleted community are never listed.
    const where = query.community_id
      ? ` WHERE community_id = ? AND ${activeCommunitySql('posts.community_id')}`
      : ` WHERE ${activeCommunitySql('posts.community_id')}`;
    const values: (string | number)[] = query.community_id
      ? [query.community_id]
      : [];
    // Pins float only within one community's listing: one community's
    // announcement has no claim on the global feed. The leading
    // (pinned_at IS NULL) term cannot be read from an index, so this is a
    // filesort over the community's posts (see the README).
    const order = query.community_id
      ? 'ORDER BY (pinned_at IS NULL), pinned_at DESC, created_at DESC, id DESC'
      : 'ORDER BY created_at DESC, id DESC';
    const [posts] = await this.pool.execute<PostRow[]>(
      `SELECT ${POST_COLUMNS} FROM posts${where} ${order} LIMIT ? OFFSET ?`,
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
      >(
        'SELECT id FROM communities WHERE id = ? AND deleted_at IS NULL LIMIT 1',
        [input.community_id],
      );

      if (!communities[0]) {
        throw new NotFoundException('Community not found');
      }
      await this.ruleAcceptance.assertAcceptedOrThrow(
        authorId,
        input.community_id,
        connection,
      );

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
        `SELECT ${POST_COLUMNS} FROM posts WHERE id = ? LIMIT 1`,
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
      `SELECT ${POST_COLUMNS} FROM posts WHERE id = ? AND ${activeCommunitySql('posts.community_id')} LIMIT 1`,
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
         WHERE posts.id = ? AND ${activeCommunitySql('posts.community_id')}
         LIMIT 1 FOR UPDATE`,
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

  // Pinning is a moderation power, not an authorship one: only the post's
  // community creator or a moderator of that community may pin or unpin. The
  // post's author may not, unlike editing and deleting, where the author may
  // act. Idempotent: pinning a pinned post changes nothing and never refreshes
  // pinned_at, which is the pinned set's ordering key.
  async pin(id: string, actorId: string): Promise<PostDto> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const post = await this.lockPostForModeration(connection, id, actorId);
      if (post.pinned_at === null) {
        if (post.removed_at !== null) {
          throw new ConflictException('A removed post cannot be pinned');
        }
        // Serialises pins within the community, so two concurrent pins at the
        // cap boundary cannot both pass the count. The count is a locking
        // read so it sees a pin committed while this transaction waited,
        // rather than the snapshot of the read above.
        await connection.execute<RowDataPacket[]>(
          'SELECT id FROM communities WHERE id = ? LIMIT 1 FOR UPDATE',
          [post.community_id],
        );
        const [counts] = await connection.execute<
          (RowDataPacket & { pinned: number | string })[]
        >(
          'SELECT COUNT(*) AS pinned FROM posts WHERE community_id = ? AND pinned_at IS NOT NULL FOR SHARE',
          [post.community_id],
        );
        if (Number(counts[0]?.pinned ?? 0) >= this.pinnedPostsMax) {
          throw new ConflictException(
            `A community can have at most ${this.pinnedPostsMax} pinned posts`,
          );
        }

        const [result] = await connection.execute<ResultSetHeader>(
          'UPDATE posts SET pinned_at = UTC_TIMESTAMP(), pinned_by = ? WHERE id = ? AND pinned_at IS NULL',
          [actorId, id],
        );
        // affectedRows 0 means the post is already pinned: nothing changed,
        // so nothing is logged and the re-read below returns it unchanged.
        if (result.affectedRows === 1) {
          await this.moderationLog.record(connection, {
            actorId,
            communityId: post.community_id,
            action: 'post_pinned',
            targetType: 'post',
            targetId: id,
          });
        }
      }

      const [posts] = await connection.execute<PostRow[]>(
        `SELECT ${POST_COLUMNS} FROM posts WHERE id = ? LIMIT 1`,
        [id],
      );
      const pinned = posts[0];
      if (!pinned) {
        throw new Error('Pinned post could not be retrieved');
      }

      await connection.commit();
      return this.toDto(pinned);
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  // Same authorisation as pin. Idempotent: unpinning an unpinned post
  // succeeds and logs nothing.
  async unpin(id: string, actorId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const post = await this.lockPostForModeration(connection, id, actorId);
      const [result] = await connection.execute<ResultSetHeader>(
        'UPDATE posts SET pinned_at = NULL, pinned_by = NULL WHERE id = ? AND pinned_at IS NOT NULL',
        [id],
      );
      if (result.affectedRows === 1) {
        await this.moderationLog.record(connection, {
          actorId,
          communityId: post.community_id,
          action: 'post_unpinned',
          targetType: 'post',
          targetId: id,
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

  // Locks the post row and decides moderation rights from it: 404 for an
  // unknown post or one in a deleted community, 403 unless the actor created
  // or moderates the post's community. Authorship is deliberately not enough.
  private async lockPostForModeration(
    connection: PoolConnection,
    id: string,
    actorId: string,
  ): Promise<PinnablePostRow> {
    const [posts] = await connection.execute<PinnablePostRow[]>(
      `SELECT posts.id, posts.community_id, posts.pinned_at, posts.removed_at,
         ${canModerateCommunitySql('posts.community_id')} AS can_moderate
       FROM posts
       WHERE posts.id = ? AND ${activeCommunitySql('posts.community_id')}
       LIMIT 1 FOR UPDATE`,
      [actorId, actorId, id],
    );
    const post = posts[0];
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (!isSqlTrue(post.can_moderate)) {
      throw new ForbiddenException(
        'Only the community creator and moderators can pin or unpin posts',
      );
    }
    return post;
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
      pinned_at: post.pinned_at ? new Date(post.pinned_at).toISOString() : null,
      pinned_by: post.pinned_by ?? null,
    };
  }
}
