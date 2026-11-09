import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
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
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import {
  COMMUNITY_VISIBLE_PREDICATE,
  visibleCommunitySql,
} from '../common/community-visibility';
import { readPositiveInteger } from '../common/read-positive-integer';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreatePostDto,
  isValidPostContent,
  POST_CONTENT_URL_MESSAGE,
} from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { ListPostsDto } from './dto/list-posts.dto';
import { loadVoteScores } from '../votes/vote-scores';
import { loadSavedFlags } from './saved-flags';
import {
  canReviewRemovedContent,
  toRemovalState,
  type RemovalStateDto,
  type RemovalStateRow,
} from '../common/removed-content';
import { RemoveContentDto } from '../common/remove-content.dto';

export interface PostRow extends RowDataPacket {
  id: string;
  title: string;
  content: string | null;
  type: 'text' | 'link' | 'media';
  author_id: string;
  community_id: string;
  created_at: Date | string;
  pinned_at: Date | string | null;
  pinned_by: string | null;
  // NULL until the author's first effective edit (migration 017).
  edited_at: Date | string | null;
  locked_at: Date | string | null;
  // NULL on a locked post once the locking moderator's account is deleted.
  locked_by: string | null;
}

// Every column of a post DTO, in DTO order.
// A post removed by moderation (removed_at, migration 017) is not listed.
export const VISIBLE_POST_SQL = 'posts.removed_at IS NULL';

export const POST_COLUMNS =
  'id, title, content, type, author_id, community_id, created_at, pinned_at, pinned_by, edited_at, locked_at, locked_by';

interface EditablePostRow extends RowDataPacket {
  id: string;
  author_id: string;
  type: 'text' | 'link' | 'media';
  title: string;
  content: string | null;
  locked_at: Date | string | null;
  removed_at: Date | string | null;
  community_id: string;
}

interface LockablePostRow extends RowDataPacket {
  id: string;
  community_id: string;
  locked_at: Date | string | null;
  removed_at: Date | string | null;
  can_moderate: number | string | boolean;
}

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
  // When the author last changed the post; null if never edited.
  edited_at: string | null;
  // When a moderator closed the post to new comments; null if open.
  locked_at: string | null;
  // NULL on a locked post once the locking moderator's account is deleted.
  locked_by: string | null;
  // Sum of all vote values; 0 without votes.
  score: number;
  // Caller-dependent: whether the viewer saved the post; false when anonymous.
  saved: boolean;
}

// A post as a reviewer sees it: removal state only on removed posts.
export type ReviewablePostDto = PostDto & Partial<RemovalStateDto>;

// The moderator-facing removal columns (migration 017), selected only by
// reads that may show them to a reviewer.
export const REMOVAL_COLUMNS = 'removed_at, removed_by, removal_reason';

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

  private readonly bans: CommunityBanPolicyService;

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly notifications: NotificationsService,
    private readonly ruleAcceptance: CommunityRuleAcceptanceService,
    private readonly moderationLog: CommunityModerationLogService,
    @Optional() bans?: CommunityBanPolicyService,
  ) {
    this.bans = bans ?? new CommunityBanPolicyService(pool);
  }

  async findAll(query: ListPostsDto, viewerId?: string): Promise<PostListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    // Posts in a deleted community, and posts removed by moderation, are
    // never listed. This is the one post listing path: GET /posts, its
    // community_id filter and GET /communities/:name/posts all run it, so
    // they cannot drift apart.
    const where = query.community_id
      ? ` WHERE community_id = ? AND ${visibleCommunitySql('posts.community_id')} AND ${VISIBLE_POST_SQL}`
      : ` WHERE ${visibleCommunitySql('posts.community_id')} AND ${VISIBLE_POST_SQL}`;
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
      items: await toPostDtos(this.pool, posts, viewerId),
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
        `SELECT id FROM communities WHERE id = ? AND ${COMMUNITY_VISIBLE_PREDICATE} LIMIT 1`,
        [input.community_id],
      );

      if (!communities[0]) {
        throw new NotFoundException('Community not found');
      }
      // Ban first, then rules: a banned user is told the actionable fact.
      await this.bans.assertNotBannedOrThrow(
        authorId,
        input.community_id,
        connection,
      );
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
      // A new post has no votes yet.
      return toPostDto(post, 0, false);
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  // GET /posts/:id. A post removed by moderation is 404 for everyone except
  // those who may review it (canReviewRemovedContent: its community's
  // creator and moderators, and platform admins), who get the full post plus
  // its removal state. The reviewer check only runs for a removed post.
  async findOne(id: string, viewerId?: string): Promise<ReviewablePostDto> {
    const [posts] = await this.pool.execute<(PostRow & RemovalStateRow)[]>(
      `SELECT ${POST_COLUMNS}, ${REMOVAL_COLUMNS} FROM posts WHERE id = ? AND ${visibleCommunitySql('posts.community_id')} LIMIT 1`,
      [id],
    );
    const post = posts[0];

    if (!post) {
      throw new NotFoundException('Post not found');
    }
    const [dto] = await toPostDtos(this.pool, [post], viewerId);
    if (!post.removed_at) {
      return dto;
    }
    if (
      !(await canReviewRemovedContent(this.pool, post.community_id, viewerId))
    ) {
      throw new NotFoundException('Post not found');
    }
    return { ...dto, ...toRemovalState(post) };
  }

  // POST /posts/:id/remove: a moderator's reversible removal. The row and
  // everything beneath it (comments, votes) stay; reads hide it (see
  // findOne). Community creator or moderator only: the author is refused,
  // having DELETE for their own content. 409 if already removed. The author
  // is notified (content_removed) with a null actor and the title snapshot
  // only: never the reason or the moderator (#44). One post_removed log
  // entry, with the reason, in the same transaction.
  async removeContent(
    id: string,
    input: RemoveContentDto,
    actorId: string,
  ): Promise<ReviewablePostDto> {
    return this.inTransaction(async (connection) => {
      const post = await this.lockPostForRemoval(connection, id, actorId);
      if (post.removed_at !== null) {
        throw new ConflictException('This post is already removed');
      }
      const reason = input.reason ?? null;
      await connection.execute<ResultSetHeader>(
        'UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = ?, removal_reason = ? WHERE id = ? AND removed_at IS NULL',
        [actorId, reason, id],
      );
      // Always true under this route's authorisation; kept so the rule
      // "an author's own act notifies nobody" is expressed in one place.
      if (post.author_id !== actorId) {
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
      await this.moderationLog.record(connection, {
        actorId,
        communityId: post.community_id,
        action: 'post_removed',
        targetType: 'post',
        targetId: id,
        ...(reason === null ? {} : { metadata: { reason } }),
      });
      return this.readReviewable(connection, id, actorId);
    });
  }

  // POST /posts/:id/restore. Same authorisation; 409 unless removed.
  // Clears all three columns. No notification: a new notifications.type
  // value would need a migration (a follow-up).
  async restore(id: string, actorId: string): Promise<PostDto> {
    return this.inTransaction(async (connection) => {
      const post = await this.lockPostForRemoval(connection, id, actorId);
      if (post.removed_at === null) {
        throw new ConflictException('This post is not removed');
      }
      await connection.execute<ResultSetHeader>(
        'UPDATE posts SET removed_at = NULL, removed_by = NULL, removal_reason = NULL WHERE id = ? AND removed_at IS NOT NULL',
        [id],
      );
      await this.moderationLog.record(connection, {
        actorId,
        communityId: post.community_id,
        action: 'post_restored',
        targetType: 'post',
        targetId: id,
      });
      const [rows] = await connection.execute<PostRow[]>(
        `SELECT ${POST_COLUMNS} FROM posts WHERE id = ? LIMIT 1`,
        [id],
      );
      const [dto] = await toPostDtos(connection, [rows[0]], actorId);
      return dto;
    });
  }

  private async readReviewable(
    connection: PoolConnection,
    id: string,
    viewerId: string,
  ): Promise<ReviewablePostDto> {
    const [rows] = await connection.execute<(PostRow & RemovalStateRow)[]>(
      `SELECT ${POST_COLUMNS}, ${REMOVAL_COLUMNS} FROM posts WHERE id = ? LIMIT 1`,
      [id],
    );
    const [dto] = await toPostDtos(connection, [rows[0]], viewerId);
    return rows[0].removed_at ? { ...dto, ...toRemovalState(rows[0]) } : dto;
  }

  // Locks the post and decides the moderator rights for remove and restore:
  // 404 for an unknown post or one in a deleted community, 403 unless the
  // actor created or moderates the community. The author is pointed at
  // DELETE.
  private async lockPostForRemoval(
    connection: PoolConnection,
    id: string,
    actorId: string,
  ): Promise<RemovablePostRow & { removed_at: Date | string | null }> {
    const [posts] = await connection.execute<
      (RemovablePostRow & { removed_at: Date | string | null })[]
    >(
      `SELECT posts.id, posts.author_id, posts.community_id, posts.title, posts.removed_at,
         ${canModerateCommunitySql('posts.community_id')} AS can_moderate
       FROM posts
       WHERE posts.id = ? AND ${visibleCommunitySql('posts.community_id')}
       LIMIT 1 FOR UPDATE`,
      [actorId, actorId, id],
    );
    const post = posts[0];
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (!isSqlTrue(post.can_moderate)) {
      throw new ForbiddenException(
        post.author_id === actorId
          ? 'Moderators remove posts; authors delete their own with DELETE /posts/:id'
          : 'Only the community creator and moderators can remove or restore posts',
      );
    }
    return post;
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
         WHERE posts.id = ? AND ${visibleCommunitySql('posts.community_id')}
         LIMIT 1 FOR UPDATE`,
        [actorId, actorId, id],
      );
      const post = posts[0];
      if (!post) {
        throw new NotFoundException('Post not found');
      }
      // Author only. A moderator's removal is POST /posts/:id/remove, which
      // keeps the content for review and restoration; moderators must not
      // also have a destructive path, or the reversible one is optional.
      if (post.author_id !== actorId) {
        throw new ForbiddenException(
          isSqlTrue(post.can_moderate)
            ? 'Only the author may delete this post; moderators remove posts with POST /posts/:id/remove'
            : 'You can only delete your own posts',
        );
      }

      await connection.execute<ResultSetHeader>(
        'DELETE FROM posts WHERE id = ?',
        [id],
      );

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

  // PATCH /posts/:id. Authorship, not moderation: only the author may edit,
  // never a moderator or the community creator (unlike remove(), where
  // moderators may act): rewriting someone's words under their name is
  // impersonation, and moderators have removal for content they object to.
  // Not gated on rule acceptance: correcting existing content is not new
  // participation. Order: 404 (unknown, or deleted or suspended community),
  // 403 (not the author), 409 (removed), 400 (content not valid for the
  // stored type). A locked post may still be edited by its author: a lock
  // closes discussion, it does not freeze the original text. Submitting the
  // stored values changes nothing and leaves edited_at untouched.
  async update(
    id: string,
    input: UpdatePostDto,
    actorId: string,
  ): Promise<PostDto> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const [posts] = await connection.execute<EditablePostRow[]>(
        `SELECT id, author_id, type, title, content, locked_at, removed_at, community_id
         FROM posts
         WHERE id = ? AND ${visibleCommunitySql('posts.community_id')}
         LIMIT 1 FOR UPDATE`,
        [id],
      );
      const post = posts[0];
      if (!post) {
        throw new NotFoundException('Post not found');
      }
      if (post.author_id !== actorId) {
        throw new ForbiddenException('Only the author may edit this post');
      }
      // Editing publishes new content into the community, so a ban refuses
      // it; deleting only removes, and stays open.
      await this.bans.assertNotBannedOrThrow(
        actorId,
        post.community_id,
        connection,
      );
      if (post.removed_at) {
        throw new ConflictException(
          'This post was removed by a moderator and cannot be edited',
        );
      }
      // The type is immutable and not in the body, so the URL rule of link
      // and media posts is applied here, against the stored type.
      if (
        input.content !== undefined &&
        !isValidPostContent(post.type, input.content)
      ) {
        throw new BadRequestException([POST_CONTENT_URL_MESSAGE]);
      }

      // Only fields that differ from the stored values are written.
      const changes: [column: 'title' | 'content', value: string][] = [];
      if (input.title !== undefined && input.title !== post.title) {
        changes.push(['title', input.title]);
      }
      if (input.content !== undefined && input.content !== post.content) {
        changes.push(['content', input.content]);
      }
      if (changes.length > 0) {
        await connection.execute<ResultSetHeader>(
          `UPDATE posts SET ${changes.map(([column]) => `${column} = ?`).join(', ')}, edited_at = UTC_TIMESTAMP() WHERE id = ?`,
          [...changes.map(([, value]) => value), id],
        );
      }

      const [rows] = await connection.execute<PostRow[]>(
        `SELECT ${POST_COLUMNS} FROM posts WHERE id = ? LIMIT 1`,
        [id],
      );
      if (!rows[0]) {
        throw new Error('Edited post could not be retrieved');
      }
      const [dto] = await toPostDtos(connection, [rows[0]], actorId);

      await connection.commit();
      return dto;
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
      const [dto] = await toPostDtos(connection, [pinned], actorId);

      await connection.commit();
      return dto;
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

  // POST /posts/:id/lock: closes the post to new comments. A moderation
  // power, like pinning: only the community creator or a moderator may lock,
  // never the author as such (the opposite of editing, where only the author
  // may act). Idempotent without refreshing locked_at: locking a locked post
  // changes and logs nothing. A removed post is 409: it has no open
  // discussion to close.
  async lock(id: string, actorId: string): Promise<PostDto> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const post = await this.lockPostForLocking(connection, id, actorId);
      if (post.removed_at !== null) {
        throw new ConflictException('A removed post cannot be locked');
      }
      const [result] = await connection.execute<ResultSetHeader>(
        'UPDATE posts SET locked_at = UTC_TIMESTAMP(), locked_by = ? WHERE id = ? AND locked_at IS NULL',
        [actorId, id],
      );
      // affectedRows 0: already locked, so nothing changed or is logged.
      if (result.affectedRows === 1) {
        await this.moderationLog.record(connection, {
          actorId,
          communityId: post.community_id,
          action: 'post_locked',
          targetType: 'post',
          targetId: id,
        });
      }

      const [posts] = await connection.execute<PostRow[]>(
        `SELECT ${POST_COLUMNS} FROM posts WHERE id = ? LIMIT 1`,
        [id],
      );
      if (!posts[0]) {
        throw new Error('Locked post could not be retrieved');
      }
      const [dto] = await toPostDtos(connection, [posts[0]], actorId);

      await connection.commit();
      return dto;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  // DELETE /posts/:id/lock. Same authorisation and 409 as lock().
  // Idempotent: unlocking an unlocked post changes and logs nothing.
  async unlock(id: string, actorId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const post = await this.lockPostForLocking(connection, id, actorId);
      if (post.removed_at !== null) {
        throw new ConflictException('A removed post cannot be unlocked');
      }
      const [result] = await connection.execute<ResultSetHeader>(
        'UPDATE posts SET locked_at = NULL, locked_by = NULL WHERE id = ? AND locked_at IS NOT NULL',
        [id],
      );
      if (result.affectedRows === 1) {
        await this.moderationLog.record(connection, {
          actorId,
          communityId: post.community_id,
          action: 'post_unlocked',
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

  // As lockPostForModeration, for the lock routes: 404 for an unknown post
  // or one in a deleted community, 403 unless the actor created or
  // moderates the post's community. Authorship is deliberately not enough.
  private async lockPostForLocking(
    connection: PoolConnection,
    id: string,
    actorId: string,
  ): Promise<LockablePostRow> {
    const [posts] = await connection.execute<LockablePostRow[]>(
      `SELECT posts.id, posts.community_id, posts.locked_at, posts.removed_at,
         ${canModerateCommunitySql('posts.community_id')} AS can_moderate
       FROM posts
       WHERE posts.id = ? AND ${visibleCommunitySql('posts.community_id')}
       LIMIT 1 FOR UPDATE`,
      [actorId, actorId, id],
    );
    const post = posts[0];
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (!isSqlTrue(post.can_moderate)) {
      throw new ForbiddenException(
        'Only the community creator and moderators can lock or unlock posts',
      );
    }
    return post;
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
       WHERE posts.id = ? AND ${visibleCommunitySql('posts.community_id')}
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
}

// Rows of one page rendered with their scores: one grouped vote aggregate
// over the page's ids (loadVoteScores), never a query per row.
// saved is caller-dependent: true only for the viewer's own saves, false
// for an anonymous viewer. knownSaved skips the lookup when the caller
// already knows (the saved-posts listing, whose posts are all saved).
export async function toPostDtos(
  executor: Pick<Pool | PoolConnection, 'execute'>,
  posts: PostRow[],
  viewerId?: string,
  knownSaved?: boolean,
): Promise<PostDto[]> {
  const ids = posts.map((post) => post.id);
  const scores = await loadVoteScores(executor, 'post', ids);
  const saved =
    knownSaved === undefined
      ? await loadSavedFlags(executor, viewerId, ids)
      : null;
  return posts.map((post) =>
    toPostDto(
      post,
      scores.get(post.id) ?? 0,
      saved ? saved.has(post.id) : (knownSaved ?? false),
    ),
  );
}

// The one post DTO: PostsService and the author feed (GET
// /users/:username/posts) both render rows selected with POST_COLUMNS.
export function toPostDto(
  post: PostRow,
  score: number,
  saved: boolean,
): PostDto {
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
    edited_at: post.edited_at ? new Date(post.edited_at).toISOString() : null,
    locked_at: post.locked_at ? new Date(post.locked_at).toISOString() : null,
    locked_by: post.locked_by ?? null,
    score,
    saved,
  };
}
