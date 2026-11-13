import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
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
import { UserBlockPolicyService } from '../users/user-block-policy.service';
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import {
  readableCommunitySql,
  visibleCommunitySql,
} from '../common/community-visibility';
import type { NotificationEntry } from '../notifications/notification-metadata';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import type {
  CommentListSort,
  ListCommentRepliesDto,
  ListCommentThreadDto,
} from './dto/list-comment-replies.dto';
import { loadVoteScores } from '../votes/vote-scores';
import {
  canReviewRemovedContent,
  toRemovalState,
  type RemovalStateDto,
  type RemovalStateRow,
} from '../common/removed-content';

interface CommentRow extends RowDataPacket {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  content: string;
  created_at: Date | string;
  edited_at?: Date | string | null;
  locked_at?: Date | string | null;
  locked_by?: string | null;
}

interface EditableCommentRow extends RowDataPacket {
  id: string;
  author_id: string;
  community_id: string;
  content: string;
  created_at: Date | string;
  edited_at: Date | string | null;
  removed_at: Date | string | null;
  post_removed_at: Date | string | null;
}

type Executor = Pick<Pool | PoolConnection, 'execute'>;

// Values: revision id, comment, replaced content, when that version was
// written.
export const INSERT_COMMENT_REVISION_SQL =
  'INSERT INTO comment_revisions (id, comment_id, content, version_at, replaced_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())';

const toIsoOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

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
  locked_at?: Date | string | null;
  locked_by?: string | null;
}

export const MAX_COMMENTS_PER_THREAD = 500;

// The tree route's post lookup: the community for the reviewer check, and
// the removal state that hides the whole thread from everyone else.
// Values: the post id, then the viewer (null when anonymous): a private
// community's threads are not there for a non-member.
export const THREAD_POST_SQL = `SELECT community_id, removed_at FROM posts WHERE id = ? AND ${readableCommunitySql('posts.community_id')} LIMIT 1`;

// The furthest a reply's ancestor walk goes. A chain this deep cannot be
// shown by the tree route anyway (MAX_COMMENTS_PER_THREAD), and the bound
// stays below MySQL's default cte_max_recursion_depth (1000), so the walk
// ends by its own WHERE rather than by a server error.
export const MAX_LOCK_ANCESTOR_DEPTH = 500;

// The parent of a reply, and whether it or any ancestor up to the root is
// locked: a comment lock closes its whole subtree, at any depth. The first
// recursive query in this codebase. It walks parent_id from the parent
// upwards, one primary-key lookup per level, stopping at the root or at
// MAX_LOCK_ANCESTOR_DEPTH levels. depth_exceeded is true when the walk
// stopped at the bound with ancestors left unchecked; the reply is then
// refused rather than let through unchecked (fail closed). Checking only the
// direct parent was rejected: replying one level deeper would bypass the
// lock. A denormalised thread_locked flag was rejected too: locking would
// have to rewrite a whole subtree, and the flag could drift.
// Values: parent id, post id, the bound, the bound. An unknown parent (or
// one on another post) yields one row of NULLs, read as not found.
export const PARENT_WITH_ANCESTRY_SQL = `WITH RECURSIVE ancestors (id, author_id, parent_id, locked_at, removed_at, depth) AS (
  SELECT id, author_id, parent_id, locked_at, removed_at, 1
  FROM comments
  WHERE id = ? AND post_id = ?
  UNION ALL
  SELECT comments.id, comments.author_id, comments.parent_id, comments.locked_at, comments.removed_at, ancestors.depth + 1
  FROM ancestors
  INNER JOIN comments ON comments.id = ancestors.parent_id
  WHERE ancestors.depth < ?
)
SELECT
  MAX(CASE WHEN depth = 1 THEN id END) AS id,
  MAX(CASE WHEN depth = 1 THEN author_id END) AS author_id,
  MAX(CASE WHEN depth = 1 THEN removed_at IS NOT NULL END) AS parent_removed,
  MAX(locked_at IS NOT NULL) AS thread_locked,
  MAX(depth = ? AND parent_id IS NOT NULL) AS depth_exceeded
FROM ancestors`;

interface ParentWithAncestryRow extends RowDataPacket {
  id: string | null;
  author_id: string;
  parent_removed: number | string | boolean | null;
  thread_locked: number | string | boolean | null;
  depth_exceeded: number | string | boolean | null;
}

// The 413 of the tree route names the way out: the two paginated routes
// together reach every comment of a thread of any size.
export const THREAD_TOO_LARGE_MESSAGE =
  `Comment threads are limited to ${MAX_COMMENTS_PER_THREAD} comments; ` +
  'page through GET /posts/:postId/comments/top-level and ' +
  'GET /comments/:id/replies instead';

// Columns of a flat listed comment. No replies: see CommentReplyDto.
const COMMENT_REPLY_COLUMNS =
  'id, post_id, parent_id, author_id, content, created_at, edited_at, locked_at, locked_by';

// Comments removed by moderation are never listed by the paginated routes.
const VISIBLE_COMMENT_SQL = 'removed_at IS NULL';

// Every comment order, read from persisted columns (comments.score and
// controversy, migration 034): the database sorts, never the application.
// The tree route builds its levels in row order, so the same ORDER BY sorts
// the siblings at every depth.
export const commentListOrder = (sort: CommentListSort): string =>
  ({
    oldest: 'ORDER BY created_at ASC, id ASC',
    new: 'ORDER BY created_at DESC, id DESC',
    top: 'ORDER BY score DESC, created_at ASC, id ASC',
    controversial: 'ORDER BY controversy DESC, created_at ASC, id ASC',
  })[sort];

export interface CommentDto {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  content: string;
  created_at: string;
  // When the author last changed the content; null if never edited.
  edited_at: string | null;
  // A lock closes this comment's whole subtree to new replies.
  locked_at: string | null;
  // NULL on a locked comment once the locking moderator's account is deleted.
  locked_by: string | null;
  // Sum of all vote values; 0 without votes.
  score: number;
  replies: CommentNodeDto[];
  // Present only on a removed comment, and only for a reviewer.
  removed?: true;
  removed_at?: string;
  removed_by?: string | null;
  removal_reason?: string | null;
}

// A removed comment as everyone but its reviewers sees it in the thread:
// the structure survives (its replies stay in place), the content and the
// author do not.
export interface CommentTombstoneDto {
  id: string;
  post_id: string;
  parent_id: string | null;
  created_at: string;
  removed: true;
  replies: CommentNodeDto[];
}

export type CommentNodeDto = CommentDto | CommentTombstoneDto;

export interface CommentThreadDto {
  post_id: string;
  comments: CommentNodeDto[];
}

// The permalink's comment, or an ancestor of it: the flat comment shape,
// with its removal state for a reviewer.
export type CommentPermalinkCommentDto = CommentReplyDto &
  Partial<RemovalStateDto>;

// A removed ancestor as everyone but its reviewers sees it: its place in
// the chain, not its content or author.
export interface CommentPermalinkTombstoneDto {
  id: string;
  post_id: string;
  parent_id: string | null;
  created_at: string;
  removed: true;
}

export type CommentPermalinkItemDto =
  CommentPermalinkCommentDto | CommentPermalinkTombstoneDto;

export interface CommentPermalinkDto {
  post_id: string;
  comment: CommentPermalinkCommentDto;
  // Root first, the direct parent last; empty for a top-level comment.
  ancestors: CommentPermalinkItemDto[];
}

// The flat comment's columns and its removal state, qualified: the
// permalink's lookup joins posts, which has columns of the same names.
const PERMALINK_COLUMNS = (table: string) =>
  [
    'id',
    'post_id',
    'parent_id',
    'author_id',
    'content',
    'created_at',
    'edited_at',
    'locked_at',
    'locked_by',
    'removed_at',
    'removed_by',
    'removal_reason',
  ]
    .map((column) => `${table}.${column}`)
    .join(', ');

// The permalink's comment, its post's community and removal state. A
// primary-key lookup joined to its post by primary key. Values: the comment
// id, then the viewer (null when anonymous).
export const PERMALINK_COMMENT_SQL = `SELECT ${PERMALINK_COLUMNS('comments')}, posts.community_id, posts.removed_at AS post_removed_at
       FROM comments
       INNER JOIN posts ON posts.id = comments.post_id
       WHERE comments.id = ? AND ${readableCommunitySql('posts.community_id')}
       LIMIT 1`;

// The chain above a comment, from its parent up to the root, one
// primary-key lookup per level, bounded like the reply lock walk
// (MAX_LOCK_ANCESTOR_DEPTH). Root first. Values: parent id, the bound.
export const PERMALINK_ANCESTORS_SQL = `WITH RECURSIVE chain (id, parent_id, depth) AS (
  SELECT id, parent_id, 1 FROM comments WHERE id = ?
  UNION ALL
  SELECT comments.id, comments.parent_id, chain.depth + 1
  FROM chain
  INNER JOIN comments ON comments.id = chain.parent_id
  WHERE chain.depth < ?
)
SELECT ${PERMALINK_COLUMNS('comments')}
FROM chain
INNER JOIN comments ON comments.id = chain.id
ORDER BY chain.depth DESC`;

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
  locked_at: string | null;
  locked_by: string | null;
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
  private readonly blocks: UserBlockPolicyService;
  private readonly bans: CommunityBanPolicyService;

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly notifications: NotificationsService,
    private readonly ruleAcceptance: CommunityRuleAcceptanceService,
    @Optional() blocks?: UserBlockPolicyService,
    @Optional() bans?: CommunityBanPolicyService,
  ) {
    this.blocks = blocks ?? new UserBlockPolicyService(pool);
    this.bans = bans ?? new CommunityBanPolicyService(pool);
  }

  // The thread varies by viewer only where content was removed. A removed
  // post's thread is 404 for everyone but its reviewers
  // (canReviewRemovedContent). A removed comment stays in the tree, so its
  // replies keep their place: reviewers see it in full with its removal
  // state, everyone else a tombstone without content or author. The
  // reviewer check runs once, and only if something in the thread is
  // removed.
  async findThread(
    postId: string,
    viewerId?: string,
    query: ListCommentThreadDto = {},
  ): Promise<CommentThreadDto> {
    const [posts] = await this.pool.execute<
      (RowDataPacket & {
        community_id: string;
        removed_at: Date | string | null;
      })[]
    >(THREAD_POST_SQL, [postId, viewerId ?? null]);
    const post = posts[0];
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    let reviewer: boolean | undefined;
    const isReviewer = async () =>
      (reviewer ??= await canReviewRemovedContent(
        this.pool,
        post.community_id,
        viewerId,
      ));
    if (post.removed_at && !(await isReviewer())) {
      throw new NotFoundException('Post not found');
    }

    const [rows] = await this.pool.execute<(CommentRow & RemovalStateRow)[]>(
      `SELECT id, post_id, author_id, parent_id, content, created_at, edited_at, locked_at, locked_by, removed_at, removed_by, removal_reason FROM comments WHERE post_id = ? ${commentListOrder(query.sort ?? 'oldest')} LIMIT ?`,
      [postId, MAX_COMMENTS_PER_THREAD + 1],
    );
    if (rows.length > MAX_COMMENTS_PER_THREAD) {
      throw new PayloadTooLargeException(THREAD_TOO_LARGE_MESSAGE);
    }
    const showRemoved = rows.some((row) => row.removed_at)
      ? await isReviewer()
      : false;

    // One grouped aggregate for the whole (bounded) thread.
    const scores = await loadVoteScores(
      this.pool,
      'comment',
      rows.map((row) => row.id),
    );
    const nodes = new Map<string, CommentNodeDto>();
    for (const row of rows) {
      const createdAt = new Date(row.created_at).toISOString();
      if (row.removed_at && !showRemoved) {
        nodes.set(row.id, {
          id: row.id,
          post_id: row.post_id,
          parent_id: row.parent_id,
          created_at: createdAt,
          removed: true,
          replies: [],
        });
        continue;
      }
      nodes.set(row.id, {
        id: row.id,
        post_id: row.post_id,
        author_id: row.author_id,
        parent_id: row.parent_id,
        content: row.content,
        created_at: createdAt,
        edited_at: toIsoOrNull(row.edited_at),
        locked_at: toIsoOrNull(row.locked_at),
        locked_by: row.locked_by ?? null,
        score: scores.get(row.id) ?? 0,
        replies: [],
        ...(row.removed_at ? toRemovalState(row) : {}),
      });
    }

    const comments: CommentNodeDto[] = [];
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

  // GET /comments/:id: one comment and its ancestors, root first, as the
  // context of a permalink. The thread's visibility rules, applied to the
  // comment's chain: 404 for an unknown or deleted comment, for one in a
  // deleted or suspended community, and for one under a removed post; a
  // removed comment is 404 itself and a tombstone as an ancestor, except for
  // its reviewers (canReviewRemovedContent), who see both in full with
  // their removal state, exactly as the thread shows them. The reviewer
  // check runs once, and only if something on the chain is removed.
  async findPermalink(
    id: string,
    viewerId?: string,
  ): Promise<CommentPermalinkDto> {
    const [targets] = await this.pool.execute<
      (CommentReplyRow &
        RemovalStateRow & {
          community_id: string;
          post_removed_at: Date | string | null;
        })[]
    >(PERMALINK_COMMENT_SQL, [id, viewerId ?? null]);
    const target = targets[0];
    if (!target) {
      throw new NotFoundException('Comment not found');
    }
    let reviewer: boolean | undefined;
    const isReviewer = async () =>
      (reviewer ??= await canReviewRemovedContent(
        this.pool,
        target.community_id,
        viewerId,
      ));
    if (
      (target.post_removed_at || target.removed_at) &&
      !(await isReviewer())
    ) {
      throw new NotFoundException('Comment not found');
    }

    const ancestors = target.parent_id
      ? (
          await this.pool.execute<(CommentReplyRow & RemovalStateRow)[]>(
            PERMALINK_ANCESTORS_SQL,
            [target.parent_id, MAX_LOCK_ANCESTOR_DEPTH],
          )
        )[0]
      : [];
    const showRemoved = ancestors.some((row) => row.removed_at)
      ? await isReviewer()
      : false;

    const shown = [...ancestors, target].filter(
      (row) => !row.removed_at || showRemoved || row === target,
    );
    const dtos = new Map(
      (await this.toReplyDtos(this.pool, shown)).map((dto) => [dto.id, dto]),
    );
    const toItem = (
      row: CommentReplyRow & RemovalStateRow,
    ): CommentPermalinkItemDto => {
      const dto = dtos.get(row.id);
      if (!dto) {
        return {
          id: row.id,
          post_id: row.post_id,
          parent_id: row.parent_id,
          created_at: new Date(row.created_at).toISOString(),
          removed: true,
        };
      }
      return row.removed_at ? { ...dto, ...toRemovalState(row) } : dto;
    };
    return {
      post_id: target.post_id,
      comment: toItem(target) as CommentReplyDto & Partial<RemovalStateDto>,
      ancestors: ancestors.map(toItem),
    };
  }

  // Direct, visible children of one comment, a page at a time. The parent
  // itself may be removed: removing a comment hides it, not the discussion
  // beneath it, so its replies stay readable here. A comment on a post in a
  // deleted community is not found.
  async findReplies(
    commentId: string,
    query: ListCommentRepliesDto,
    viewerId?: string,
  ): Promise<CommentReplyListDto> {
    const [parents] = await this.pool.execute<
      (RowDataPacket & { id: string })[]
    >(
      `SELECT comments.id FROM comments
       INNER JOIN posts ON posts.id = comments.post_id
       WHERE comments.id = ? AND ${readableCommunitySql('posts.community_id')}
         AND posts.removed_at IS NULL
       LIMIT 1`,
      [commentId, viewerId ?? null],
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
    viewerId?: string,
  ): Promise<CommentReplyListDto> {
    await this.ensurePostExists(postId, viewerId);
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
    return {
      items: await this.toReplyDtos(this.pool, rows),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
      sort,
    };
  }

  // One comment as the flat item of the paginated routes, read on the
  // caller's connection (inside its transaction). The response of
  // PATCH /comments/:id and POST /comments/:id/lock.
  async readFlat(executor: Executor, id: string): Promise<CommentReplyDto> {
    const [rows] = await executor.execute<CommentReplyRow[]>(
      `SELECT ${COMMENT_REPLY_COLUMNS} FROM comments WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!rows[0]) {
      throw new Error(`Comment ${id} could not be retrieved`);
    }
    const [dto] = await this.toReplyDtos(executor, [rows[0]]);
    return dto;
  }

  // Flat comments with their reply counts and scores: two grouped queries
  // over the rows' ids, whatever their number.
  private async toReplyDtos(
    executor: Executor,
    rows: CommentReplyRow[],
  ): Promise<CommentReplyDto[]> {
    const ids = rows.map((row) => row.id);
    const replyCounts = await this.countReplies(executor, ids);
    const scores = await loadVoteScores(executor, 'comment', ids);
    return rows.map((row) => ({
      id: row.id,
      post_id: row.post_id,
      parent_id: row.parent_id,
      author_id: row.author_id,
      content: row.content,
      created_at: new Date(row.created_at).toISOString(),
      edited_at: toIsoOrNull(row.edited_at),
      locked_at: toIsoOrNull(row.locked_at),
      locked_by: row.locked_by ?? null,
      reply_count: replyCounts.get(row.id) ?? 0,
      score: scores.get(row.id) ?? 0,
    }));
  }

  // Visible direct replies per comment id: one grouped query over the
  // page's ids, not a subquery per row. An id absent from the result has
  // no replies.
  private async countReplies(
    executor: Executor,
    ids: string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const [rows] = await executor.execute<
      (RowDataPacket & { parent_id: string; reply_count: number | string })[]
    >(
      `SELECT parent_id, COUNT(*) AS reply_count FROM comments WHERE parent_id IN (${ids.map(() => '?').join(', ')}) AND ${VISIBLE_COMMENT_SQL} GROUP BY parent_id`,
      ids,
    );
    return new Map(rows.map((row) => [row.parent_id, Number(row.reply_count)]));
  }

  // PATCH /comments/:id. Only the author may edit, never a moderator or the
  // community creator (unlike remove(), where moderators may act). Not gated
  // on rule acceptance: correcting existing content is not new
  // participation. Order: 404 (unknown, or deleted or suspended community),
  // 403 (not the author), 409 (the comment or its post removed). A lock does
  // not stop the edit: a lock closes the discussion to new replies, it does
  // not freeze what was already written (as for a locked post). Submitting
  // the stored content changes nothing and leaves edited_at untouched.
  // Returns the flat comment, not a thread node with an empty replies array
  // that would misrepresent its replies.
  async update(
    id: string,
    input: UpdateCommentDto,
    actorId: string,
  ): Promise<CommentReplyDto> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;

    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const [comments] = await connection.execute<EditableCommentRow[]>(
        `SELECT comments.id, comments.author_id, comments.content,
           comments.created_at, comments.edited_at,
           comments.removed_at, posts.removed_at AS post_removed_at,
           posts.community_id
         FROM comments
         INNER JOIN posts ON posts.id = comments.post_id
         WHERE comments.id = ? AND ${visibleCommunitySql('posts.community_id')}
         LIMIT 1 FOR UPDATE OF comments`,
        [id],
      );
      const comment = comments[0];
      if (!comment) {
        throw new NotFoundException('Comment not found');
      }
      if (comment.author_id !== actorId) {
        throw new ForbiddenException('Only the author may edit this comment');
      }
      // Editing publishes new content; deleting only removes and stays open.
      await this.bans.assertNotBannedOrThrow(
        actorId,
        comment.community_id,
        connection,
      );
      if (comment.removed_at || comment.post_removed_at) {
        throw new ConflictException(
          comment.removed_at
            ? 'This comment was removed by a moderator and cannot be edited'
            : 'The post of this comment was removed and its comments cannot be edited',
        );
      }

      if (input.content !== comment.content) {
        // The version being replaced (migration 039): GET
        // /comments/:id/revisions.
        await connection.execute<ResultSetHeader>(INSERT_COMMENT_REVISION_SQL, [
          randomUUID(),
          id,
          comment.content,
          comment.edited_at ?? comment.created_at,
        ]);
        await connection.execute<ResultSetHeader>(
          'UPDATE comments SET content = ?, edited_at = UTC_TIMESTAMP() WHERE id = ?',
          [input.content, id],
        );
      }

      const dto = await this.readFlat(connection, id);

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

      // A share lock on the post serialises this insert against a concurrent
      // POST /posts/:id/lock, which takes the row FOR UPDATE.
      const [posts] = await connection.execute<
        (RowDataPacket & {
          id: string;
          author_id: string;
          community_id: string;
          title: string;
          locked_at: Date | string | null;
          removed_at?: Date | string | null;
        })[]
      >(
        `SELECT id, author_id, community_id, title, locked_at, removed_at FROM posts WHERE id = ? AND ${readableCommunitySql('posts.community_id')} LIMIT 1 FOR SHARE`,
        [postId, authorId],
      );
      const post = posts[0];
      if (!post) {
        throw new NotFoundException('Post not found');
      }

      const parentId = input.parent_id ?? null;
      let parentAuthorId: string | null = null;
      let parentRemoved = false;
      let threadLocked = false;
      let threadTooDeep = false;
      if (parentId !== null) {
        const [parents] = await connection.execute<ParentWithAncestryRow[]>(
          PARENT_WITH_ANCESTRY_SQL,
          [parentId, postId, MAX_LOCK_ANCESTOR_DEPTH, MAX_LOCK_ANCESTOR_DEPTH],
        );
        const parent = parents[0];
        if (!parent?.id) {
          throw new NotFoundException('Parent comment not found for this post');
        }
        parentAuthorId = parent.author_id;
        parentRemoved = isSqlTrue(parent.parent_removed ?? 0);
        threadLocked = isSqlTrue(parent.thread_locked ?? 0);
        threadTooDeep = isSqlTrue(parent.depth_exceeded ?? 0);
      }
      // Ban first, then rules: a banned user is told the actionable fact.
      await this.bans.assertNotBannedOrThrow(
        authorId,
        post.community_id,
        connection,
      );
      await this.ruleAcceptance.assertAcceptedOrThrow(
        authorId,
        post.community_id,
        connection,
      );
      // A comment is directed at the post's author, a reply at the parent
      // comment's author, never at the post's: replying to someone else's
      // comment under a blocked user's post is not interacting with them.
      // After the 404s and the rule gate, so an unknown post is still a 404
      // and the check never confirms a post exists.
      await this.blocks.assertNotBlockedOrThrow(
        authorId,
        parentAuthorId ?? post.author_id,
        connection,
      );
      // After the 404s and the rule gate, so a caller sees the most specific
      // error. A lock binds everyone, moderators and the creator included:
      // they must unlock first, which leaves a log entry.
      // Removed content takes no new comments: 409, after the 404s and the
      // rule gate, before the locks.
      if (post.removed_at) {
        throw new ConflictException(
          'This post was removed by a moderator; it accepts no new comments',
        );
      }
      if (parentRemoved) {
        throw new ConflictException(
          'The comment being replied to was removed by a moderator',
        );
      }
      if (post.locked_at) {
        throw new ConflictException(
          'This post is locked; it accepts no new comments',
        );
      }
      if (threadLocked) {
        throw new ConflictException(
          'A comment above this reply is locked; its thread accepts no new replies',
        );
      }
      if (threadTooDeep) {
        throw new ConflictException(
          `This thread is nested more than ${MAX_LOCK_ANCESTOR_DEPTH} levels deep and accepts no new replies`,
        );
      }

      const id = randomUUID();
      await connection.execute<ResultSetHeader>(
        'INSERT INTO comments (id, post_id, author_id, parent_id, content) VALUES (?, ?, ?, ?, ?)',
        [id, postId, authorId, parentId, input.content.trim()],
      );

      const [comments] = await connection.execute<CommentRow[]>(
        'SELECT id, post_id, author_id, parent_id, content, created_at, edited_at, locked_at, locked_by FROM comments WHERE id = ? LIMIT 1',
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
        edited_at: toIsoOrNull(comment.edited_at),
        locked_at: toIsoOrNull(comment.locked_at),
        locked_by: comment.locked_by ?? null,
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
         WHERE comments.id = ? AND ${visibleCommunitySql('posts.community_id')}
         LIMIT 1 FOR UPDATE OF comments`,
        [actorId, actorId, id],
      );
      const comment = comments[0];
      if (!comment) {
        throw new NotFoundException('Comment not found');
      }
      // Author only. A moderator's removal is POST /comments/:id/remove,
      // which keeps the content for review and restoration.
      if (comment.author_id !== actorId) {
        throw new ForbiddenException(
          isSqlTrue(comment.can_moderate)
            ? 'Only the author may delete this comment; moderators remove comments with POST /comments/:id/remove'
            : 'You can only delete your own comments',
        );
      }

      await connection.execute<ResultSetHeader>(
        'DELETE FROM comments WHERE id = ?',
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

  private async ensurePostExists(
    postId: string,
    viewerId?: string,
  ): Promise<void> {
    const [posts] = await this.pool.execute<(RowDataPacket & { id: string })[]>(
      // Visible posts only: a removed post's flat routes are 404 for
      // everyone; reviewers read it through the tree route.
      `SELECT id FROM posts WHERE id = ? AND ${readableCommunitySql('posts.community_id')} AND posts.removed_at IS NULL LIMIT 1`,
      [postId, viewerId ?? null],
    );
    if (!posts[0]) {
      throw new NotFoundException('Post not found');
    }
  }
}
