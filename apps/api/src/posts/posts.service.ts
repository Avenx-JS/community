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
import type { ListFeedDto } from './dto/list-feed.dto';
import type {
  PostListingQueryDto,
  PostListSort,
  PostTopWindow,
} from './dto/post-listing-query.dto';
import { notBlockedByViewerSql } from '../users/user-block-policy.service';
import { ACTIVE_COMMUNITY_BAN_PREDICATE } from '../common/active-community-ban';
import {
  NEW_POST_HOT_RANK_SQL,
  NEW_POST_RISING_RANK_SQL,
  RISING_WINDOW_HOURS,
} from '../common/content-ranking';
import { loadVoteScores } from '../votes/vote-scores';
import { loadSavedFlags } from './saved-flags';
import {
  canReviewRemovedContent,
  toRemovalState,
  type RemovalStateDto,
  type RemovalStateRow,
} from '../common/removed-content';
import { RemoveContentDto } from '../common/remove-content.dto';
import {
  loadMediaByIds,
  toMediaDto,
  type MediaDto,
  type MediaRow,
} from '../media/media-dto';
import { MEDIA_COLUMNS, RELEASE_POST_MEDIA_SQL } from '../media/media-sql';
import { MediaCleanupService } from '../media/media-cleanup.service';

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
  // The uploaded file of a media post (migration 035); NULL otherwise, and
  // on media posts created before uploads existed.
  media_id?: string | null;
}

// Every column of a post DTO, in DTO order.
// A post removed by moderation (removed_at, migration 017) is not listed.
export const VISIBLE_POST_SQL = 'posts.removed_at IS NULL';

export const POST_COLUMNS =
  'id, title, content, type, author_id, community_id, created_at, pinned_at, pinned_by, edited_at, locked_at, locked_by, media_id';

interface EditablePostRow extends RowDataPacket {
  id: string;
  author_id: string;
  type: 'text' | 'link' | 'media';
  title: string;
  content: string | null;
  locked_at: Date | string | null;
  removed_at: Date | string | null;
  community_id: string;
  media_id: string | null;
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
  // A media post's file; null on every other post.
  media: MediaDto | null;
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
  sort: PostListSort;
  // Present with sort=top only: the window that was ranked.
  time?: PostTopWindow;
}

// Whose posts a listing reads: every visible post, one community's, or the
// subscribed communities of one account (GET /feed).
export interface PostListScope {
  community_id?: string;
  subscriber_id?: string;
}

// The windows of sort=top and sort=rising, against created_at. Compared
// with CURRENT_TIMESTAMP, the clock created_at defaults to, so the window is
// right whatever the session time zone.
const TOP_WINDOW_SQL: Record<Exclude<PostTopWindow, 'all'>, string> = {
  hour: 'INTERVAL 1 HOUR',
  day: 'INTERVAL 1 DAY',
  week: 'INTERVAL 7 DAY',
  month: 'INTERVAL 30 DAY',
  year: 'INTERVAL 365 DAY',
};
const createdWithinSql = (interval: string) =>
  `posts.created_at >= CURRENT_TIMESTAMP - ${interval}`;

// The feed's communities: the account's subscriptions (primary key
// (user_id, community_id)), less any community it is banned from now. A ban
// deletes the subscription, so this only matters for a row that survived
// one; it costs a probe of idx_community_bans_active per subscription.
export const FEED_COMMUNITIES_SQL = `posts.community_id IN (
         SELECT community_subscriptions.community_id FROM community_subscriptions
         WHERE community_subscriptions.user_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM community_bans
             WHERE community_bans.community_id = community_subscriptions.community_id
               AND community_bans.user_id = community_subscriptions.user_id
               AND ${ACTIVE_COMMUNITY_BAN_PREDICATE}
           )
       )`;

// The feed is the caller's own surface, so it omits the authors the caller
// has blocked, in that direction only (see "Blocking users").
export const FEED_UNBLOCKED_AUTHOR_SQL = notBlockedByViewerSql(
  '?',
  'posts.author_id',
);

export function postListingWhere(
  scope: PostListScope,
  sort: PostListSort,
  time?: PostTopWindow,
): { where: string; values: string[] } {
  const conditions: string[] = [];
  const values: string[] = [];
  if (scope.community_id) {
    conditions.push('community_id = ?');
    values.push(scope.community_id);
  }
  if (scope.subscriber_id) {
    conditions.push(FEED_COMMUNITIES_SQL);
    values.push(scope.subscriber_id);
  }
  conditions.push(visibleCommunitySql('posts.community_id'), VISIBLE_POST_SQL);
  if (scope.subscriber_id) {
    conditions.push(FEED_UNBLOCKED_AUTHOR_SQL);
    values.push(scope.subscriber_id);
  }
  if (sort === 'top' && time && time !== 'all') {
    conditions.push(createdWithinSql(TOP_WINDOW_SQL[time]));
  }
  if (sort === 'rising') {
    conditions.push(createdWithinSql(`INTERVAL ${RISING_WINDOW_HOURS} HOUR`));
  }
  return { where: ` WHERE ${conditions.join(' AND ')}`, values };
}

// Pins float only within one community's listing, and only on the
// chronological and hot views: one community's announcement has no claim on
// the global listing or the feed, and top and rising are rankings a pin
// would falsify. The leading (pinned_at IS NULL) term cannot be read from an
// index, so a community listing is a filesort over that community's posts
// (see the README). id DESC breaks every tie.
export function postListingOrder(
  scope: PostListScope,
  sort: PostListSort,
): string {
  const pins =
    scope.community_id && (sort === 'new' || sort === 'hot')
      ? '(pinned_at IS NULL), pinned_at DESC, '
      : '';
  const key = {
    new: 'created_at DESC, id DESC',
    hot: 'hot_rank DESC, id DESC',
    top: 'score DESC, id DESC',
    rising: 'rising_rank DESC, id DESC',
  }[sort];
  return `ORDER BY ${pins}${key}`;
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
    // Optional so the service also runs without the media module (tests);
    // the periodic sweep frees released files then.
    @Optional() private readonly mediaCleanup?: MediaCleanupService,
  ) {
    this.bans = bans ?? new CommunityBanPolicyService(pool);
  }

  // The upload a media post attaches: the author's own, for a post, not
  // released and used by no post. Locked FOR UPDATE, so a concurrent
  // DELETE /media/:id or a second post waits; uq_posts_media_id is the
  // backstop. Another account's upload is 404, like an unknown one.
  private async lockAttachableMedia(
    connection: PoolConnection,
    mediaId: string | undefined,
    authorId: string,
  ): Promise<MediaRow> {
    const [rows] = await connection.execute<
      (MediaRow & {
        released_at: Date | string | null;
        attached: number | string | boolean;
      })[]
    >(
      `SELECT ${MEDIA_COLUMNS}, media.released_at,
         EXISTS (SELECT 1 FROM posts WHERE posts.media_id = media.id) AS attached
       FROM media WHERE media.id = ? LIMIT 1 FOR UPDATE`,
      [mediaId ?? ''],
    );
    const media = rows[0];
    if (
      !media ||
      media.uploader_id !== authorId ||
      media.purpose !== 'post' ||
      media.released_at
    ) {
      throw new NotFoundException('Media not found');
    }
    if (isSqlTrue(media.attached)) {
      throw new ConflictException('This upload is already attached to a post');
    }
    return media;
  }

  // GET /posts and GET /communities/:name/posts (with community_id).
  findAll(query: ListPostsDto, viewerId?: string): Promise<PostListDto> {
    return query.community_id
      ? this.list({ community_id: query.community_id }, query, viewerId)
      : this.list({}, query, viewerId);
  }

  // GET /feed: posts of the caller's subscribed communities.
  findFeed(query: ListFeedDto, userId: string): Promise<PostListDto> {
    return this.list({ subscriber_id: userId }, query, userId);
  }

  // The one post listing path: GET /posts, its community_id filter,
  // GET /communities/:name/posts and GET /feed all run it, so they cannot
  // drift apart. Posts in a deleted or suspended community, and posts
  // removed by moderation, are never listed. Every order is read from
  // persisted columns (posts.hot_rank, score, rising_rank, created_at), so
  // the database sorts, never the application.
  private async list(
    scope: PostListScope,
    query: PostListingQueryDto,
    viewerId?: string,
  ): Promise<PostListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const sort = query.sort ?? 'new';
    const time = sort === 'top' ? (query.time ?? 'all') : undefined;
    const { where, values } = postListingWhere(scope, sort, time);
    const [posts] = await this.pool.execute<PostRow[]>(
      `SELECT ${POST_COLUMNS} FROM posts${where} ${postListingOrder(scope, sort)} LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number })[]
    >(`SELECT COUNT(*) AS total FROM posts${where}`, values);

    return {
      items: await toPostDtos(this.pool, posts, viewerId),
      page,
      limit,
      total: Number(countRows[0].total),
      sort,
      ...(time ? { time } : {}),
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

      const media =
        input.type === 'media'
          ? await this.lockAttachableMedia(connection, input.media_id, authorId)
          : null;

      const id = randomUUID();
      await connection.execute<ResultSetHeader>(
        // A new post has no votes; its ranks are those of score 0 now.
        `INSERT INTO posts (id, title, content, type, author_id, community_id, media_id, hot_rank, rising_rank) VALUES (?, ?, ?, ?, ?, ?, ?, ${NEW_POST_HOT_RANK_SQL}, ${NEW_POST_RISING_RANK_SQL})`,
        [
          id,
          input.title.trim(),
          input.content?.trim() ?? null,
          input.type,
          authorId,
          input.community_id,
          media?.id ?? null,
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
      return toPostDto(post, 0, false, media ? toMediaDto(media) : null);
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

      // The file goes with the post: released here, deleted by the sweep.
      await connection.execute<ResultSetHeader>(RELEASE_POST_MEDIA_SQL, [id]);
      await connection.execute<ResultSetHeader>(
        'DELETE FROM posts WHERE id = ?',
        [id],
      );

      await connection.commit();
      this.mediaCleanup?.requestSweep();
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
        `SELECT id, author_id, type, title, content, locked_at, removed_at, community_id, media_id
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
        !isValidPostContent(post.type, input.content, !!post.media_id)
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
  const media = await loadMediaByIds(
    executor,
    posts.map((post) => post.media_id),
  );
  const saved =
    knownSaved === undefined
      ? await loadSavedFlags(executor, viewerId, ids)
      : null;
  return posts.map((post) =>
    toPostDto(
      post,
      scores.get(post.id) ?? 0,
      saved ? saved.has(post.id) : (knownSaved ?? false),
      (post.media_id && media.get(post.media_id)) || null,
    ),
  );
}

// The one post DTO: PostsService and the author feed (GET
// /users/:username/posts) both render rows selected with POST_COLUMNS.
export function toPostDto(
  post: PostRow,
  score: number,
  saved: boolean,
  media: MediaDto | null = null,
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
    media,
  };
}
