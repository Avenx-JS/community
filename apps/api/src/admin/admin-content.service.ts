import {
  ConflictException,
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
import { inTransaction } from '../communities/community-access';
import { isSqlTrue } from '../common/community-moderation';
import { escapeLikeSearch } from '../common/like-search';
import { NotificationsService } from '../notifications/notifications.service';
import { CLOSE_COMMUNITY_REPORTS_SQL } from '../reports/community-report-review';
import {
  AuditLogService,
  type AuditEntry,
  type ContentState,
} from './audit-log.service';
import type {
  AdminContentCommunityState,
  AdminContentState,
  AdminReasonDto,
  ListAdminCommentsDto,
  ListAdminPostsDto,
} from './dto/admin-content.dto';

// The platform administrators' view of posts and comments. Unlike every
// public route it hides nothing: removed content, and content in suspended
// and soft-deleted communities, whose public routes answer 404 to everyone,
// their own moderators included. An administrator's removal sets
// removed_by_admin (migration 041), which community moderators cannot undo;
// an administrator may restore any removal. Each action writes one audit
// entry with the reason, in its transaction.

export type AdminCommunityStateName = Exclude<
  AdminContentCommunityState,
  'any'
>;

export interface AdminRemoval {
  removed_at: string;
  // Null once the remover's account is gone or anonymised.
  removed_by_id: string | null;
  removed_by_username: string | null;
  reason: string | null;
  source: 'moderator' | 'admin';
}

interface AdminContentBase {
  id: string;
  community_id: string;
  community_name: string;
  community_state: AdminCommunityStateName;
  author_id: string;
  // Null once the author's account is anonymised.
  author_username: string | null;
  created_at: string;
  edited_at: string | null;
  score: number;
  locked_at: string | null;
  // Null while visible.
  removal: AdminRemoval | null;
}

export interface AdminPostListItem extends AdminContentBase {
  title: string;
  type: string;
  pinned_at: string | null;
}

export interface AdminPostDetail extends AdminPostListItem {
  content: string | null;
  upvotes: number;
  downvotes: number;
  // Every comment, removed ones included.
  comment_count: number;
  // Platform reports about the post, open or under review, not withdrawn.
  open_report_count: number;
}

export interface AdminCommentListItem extends AdminContentBase {
  post_id: string;
  post_title: string;
  // Whether the comment's post is removed (by anyone).
  post_removed: boolean;
  parent_id: string | null;
  // The first 200 characters; the detail has the full content.
  excerpt: string;
}

export interface AdminCommentDetail extends Omit<
  AdminCommentListItem,
  'excerpt'
> {
  content: string;
  upvotes: number;
  downvotes: number;
  // Direct replies, removed ones included.
  reply_count: number;
  open_report_count: number;
}

export interface AdminContentList<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  filters: {
    search: string | null;
    community_id: string | null;
    author_username: string | null;
    state: AdminContentState;
    community_state: AdminContentCommunityState;
    sort: 'new' | 'oldest';
  } & Record<string, string | null>;
}

interface ContentRow extends RowDataPacket {
  id: string;
  community_id: string;
  community_name: string;
  community_state: AdminCommunityStateName;
  author_id: string;
  author_username: string | null;
  created_at: Date | string;
  edited_at: Date | string | null;
  score: number | string;
  locked_at: Date | string | null;
  removed_at: Date | string | null;
  removed_by: string | null;
  removed_by_username: string | null;
  removal_reason: string | null;
  removed_by_admin: number | string | boolean;
}

interface PostRow extends ContentRow {
  title: string;
  type: string;
  pinned_at: Date | string | null;
}

interface PostDetailRow extends PostRow {
  content: string | null;
  upvotes: number | string;
  downvotes: number | string;
  comment_count: number | string;
  open_report_count: number | string;
}

interface CommentFieldsRow extends ContentRow {
  post_id: string;
  post_title: string;
  post_removed_at: Date | string | null;
  parent_id: string | null;
}

interface CommentRow extends CommentFieldsRow {
  excerpt: string;
}

interface CommentDetailRow extends CommentFieldsRow {
  content: string;
  upvotes: number | string;
  downvotes: number | string;
  reply_count: number | string;
  open_report_count: number | string;
}

interface LockedContentRow extends RowDataPacket {
  id: string;
  author_id: string;
  community_id: string;
  community_name: string;
  removed_at: Date | string | null;
  removed_by_admin: number | string | boolean;
  post_removed_at?: Date | string | null;
  title?: string;
  content?: string;
}

// An anonymised account is null, never its deleted_<id> placeholder.
const visibleUsername = (alias: string) =>
  `CASE WHEN ${alias}.deleted_at IS NULL THEN ${alias}.username END`;

// deleted wins over suspended, as in GET /admin/communities.
export const COMMUNITY_STATE_SQL = `CASE WHEN c.deleted_at IS NOT NULL THEN 'deleted'
           WHEN c.suspended_at IS NOT NULL THEN 'suspended' ELSE 'active' END`;

const COMMUNITY_STATE_FILTER: Record<AdminCommunityStateName, string> = {
  active: 'c.deleted_at IS NULL AND c.suspended_at IS NULL',
  suspended: 'c.suspended_at IS NOT NULL AND c.deleted_at IS NULL',
  deleted: 'c.deleted_at IS NOT NULL',
};

const stateFilter = (
  alias: string,
): Record<Exclude<AdminContentState, 'any'>, string> => ({
  visible: `${alias}.removed_at IS NULL`,
  removed: `${alias}.removed_at IS NOT NULL`,
  moderator_removed: `${alias}.removed_at IS NOT NULL AND ${alias}.removed_by_admin = FALSE`,
  admin_removed: `${alias}.removed_by_admin = TRUE`,
});

// Columns both kinds share, for alias x (p or cm).
const SHARED_COLUMNS = (x: string) => `${x}.id, c.id AS community_id,
         c.name AS community_name, ${COMMUNITY_STATE_SQL} AS community_state,
         ${x}.author_id, ${visibleUsername('author')} AS author_username,
         ${x}.created_at, ${x}.edited_at, ${x}.score, ${x}.locked_at,
         ${x}.removed_at, ${x}.removed_by, ${visibleUsername('remover')} AS removed_by_username,
         ${x}.removal_reason, ${x}.removed_by_admin`;

const POST_FROM = `FROM posts p
       INNER JOIN communities c ON c.id = p.community_id
       INNER JOIN users author ON author.id = p.author_id
       LEFT JOIN users remover ON remover.id = p.removed_by`;

const COMMENT_FROM = `FROM comments cm
       INNER JOIN posts p ON p.id = cm.post_id
       INNER JOIN communities c ON c.id = p.community_id
       INNER JOIN users author ON author.id = cm.author_id
       LEFT JOIN users remover ON remover.id = cm.removed_by`;

const POST_COLUMNS = `${SHARED_COLUMNS('p')}, p.title, p.type, p.pinned_at`;

const COMMENT_COLUMNS = `${SHARED_COLUMNS('cm')}, cm.post_id, p.title AS post_title,
         p.removed_at AS post_removed_at, cm.parent_id`;

const OPEN_REPORTS = (type: 'post' | 'comment', id: string) =>
  `(SELECT COUNT(*) FROM user_reports ur
          WHERE ur.target_type = '${type}' AND ur.target_id = ${id}
            AND ur.status IN ('open', 'under_review') AND ur.withdrawn_at IS NULL)`;

// One row, so correlated subqueries are fine, as in GET /admin/communities/:id.
export const ADMIN_POST_DETAIL_SQL = `SELECT ${POST_COLUMNS}, p.content, p.upvotes, p.downvotes,
         (SELECT COUNT(*) FROM comments x WHERE x.post_id = p.id) AS comment_count,
         ${OPEN_REPORTS('post', 'p.id')} AS open_report_count
       ${POST_FROM}
       WHERE p.id = ? LIMIT 1`;

export const ADMIN_COMMENT_DETAIL_SQL = `SELECT ${COMMENT_COLUMNS}, cm.content, cm.upvotes, cm.downvotes,
         (SELECT COUNT(*) FROM comments x WHERE x.parent_id = cm.id) AS reply_count,
         ${OPEN_REPORTS('comment', 'cm.id')} AS open_report_count
       ${COMMENT_FROM}
       WHERE cm.id = ? LIMIT 1`;

// The content row locked for an action, whatever its community's state.
export const LOCK_POST_SQL = `SELECT p.id, p.author_id, p.title, p.community_id, c.name AS community_name,
         p.removed_at, p.removed_by_admin
       FROM posts p INNER JOIN communities c ON c.id = p.community_id
       WHERE p.id = ? LIMIT 1 FOR UPDATE OF p`;

export const LOCK_COMMENT_SQL = `SELECT cm.id, cm.author_id, cm.content, p.community_id, c.name AS community_name,
         cm.removed_at, cm.removed_by_admin, p.removed_at AS post_removed_at
       FROM comments cm
       INNER JOIN posts p ON p.id = cm.post_id
       INNER JOIN communities c ON c.id = p.community_id
       WHERE cm.id = ? LIMIT 1 FOR UPDATE OF cm`;

// Values: actor, reason, id. Takes over a moderator's removal too.
export const ADMIN_REMOVE_SQL = (table: 'posts' | 'comments') =>
  `UPDATE ${table} SET removed_at = UTC_TIMESTAMP(), removed_by = ?, removal_reason = ?, removed_by_admin = TRUE WHERE id = ? AND removed_by_admin = FALSE`;

export const ADMIN_RESTORE_SQL = (table: 'posts' | 'comments') =>
  `UPDATE ${table} SET removed_at = NULL, removed_by = NULL, removal_reason = NULL, removed_by_admin = FALSE WHERE id = ? AND removed_at IS NOT NULL`;

const toIso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

function toRemoval(row: ContentRow): AdminRemoval | null {
  if (row.removed_at === null) {
    return null;
  }
  return {
    removed_at: new Date(row.removed_at).toISOString(),
    removed_by_id: row.removed_by ?? null,
    removed_by_username: row.removed_by_username ?? null,
    reason: row.removal_reason ?? null,
    source: isSqlTrue(row.removed_by_admin) ? 'admin' : 'moderator',
  };
}

function toBase(row: ContentRow): AdminContentBase {
  return {
    id: row.id,
    community_id: row.community_id,
    community_name: row.community_name,
    community_state: row.community_state,
    author_id: row.author_id,
    author_username: row.author_username ?? null,
    created_at: new Date(row.created_at).toISOString(),
    edited_at: toIso(row.edited_at),
    score: Number(row.score),
    locked_at: toIso(row.locked_at),
    removal: toRemoval(row),
  };
}

function toPostItem(row: PostRow): AdminPostListItem {
  return {
    ...toBase(row),
    title: row.title,
    type: row.type,
    pinned_at: toIso(row.pinned_at),
  };
}

function toCommentFields(
  row: CommentFieldsRow,
): Omit<AdminCommentListItem, 'excerpt'> {
  return {
    ...toBase(row),
    post_id: row.post_id,
    post_title: row.post_title,
    post_removed: row.post_removed_at !== null,
    parent_id: row.parent_id,
  };
}

function toCommentItem(row: CommentRow): AdminCommentListItem {
  return { ...toCommentFields(row), excerpt: row.excerpt };
}

// The audit entry of an administrator's content action.
function contentAuditEntry(
  kind: 'post' | 'comment',
  act: 'removed' | 'restored',
  actorId: string,
  targetId: string,
  metadata: {
    community_name: string;
    previous_state: ContentState;
    reason: string;
  },
): AuditEntry {
  return kind === 'post'
    ? {
        actorId,
        action: act === 'removed' ? 'post_removed' : 'post_restored',
        targetType: 'post',
        targetId,
        metadata,
      }
    : {
        actorId,
        action: act === 'removed' ? 'comment_removed' : 'comment_restored',
        targetType: 'comment',
        targetId,
        metadata,
      };
}

function stateOf(row: LockedContentRow): ContentState {
  if (row.removed_at === null) return 'visible';
  return isSqlTrue(row.removed_by_admin)
    ? 'admin_removed'
    : 'moderator_removed';
}

@Injectable()
export class AdminContentService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  async findPosts(
    query: ListAdminPostsDto,
  ): Promise<AdminContentList<AdminPostListItem>> {
    const { where, values } = this.filters('p', query, 'p.title');
    const [rows, total] = await this.page<PostRow>(
      POST_COLUMNS,
      POST_FROM,
      'p',
      where,
      values,
      query,
    );
    return this.list(rows.map(toPostItem), total, query, {});
  }

  async findComments(
    query: ListAdminCommentsDto,
  ): Promise<AdminContentList<AdminCommentListItem>> {
    const { where, values } = this.filters('cm', query, 'cm.content');
    if (query.post_id) {
      where.push('cm.post_id = ?');
      values.push(query.post_id);
    }
    const [rows, total] = await this.page<CommentRow>(
      `${COMMENT_COLUMNS}, LEFT(cm.content, 200) AS excerpt`,
      COMMENT_FROM,
      'cm',
      where,
      values,
      query,
    );
    return this.list(rows.map(toCommentItem), total, query, {
      post_id: query.post_id ?? null,
    });
  }

  async findPost(
    id: string,
    executor: Pick<Pool | PoolConnection, 'execute'> = this.pool,
  ): Promise<AdminPostDetail> {
    const [rows] = await executor.execute<PostDetailRow[]>(
      ADMIN_POST_DETAIL_SQL,
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Post not found');
    }
    return {
      ...toPostItem(row),
      content: row.content,
      upvotes: Number(row.upvotes),
      downvotes: Number(row.downvotes),
      comment_count: Number(row.comment_count),
      open_report_count: Number(row.open_report_count),
    };
  }

  async findComment(
    id: string,
    executor: Pick<Pool | PoolConnection, 'execute'> = this.pool,
  ): Promise<AdminCommentDetail> {
    const [rows] = await executor.execute<CommentDetailRow[]>(
      ADMIN_COMMENT_DETAIL_SQL,
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Comment not found');
    }
    return {
      ...toCommentFields(row),
      content: row.content,
      upvotes: Number(row.upvotes),
      downvotes: Number(row.downvotes),
      reply_count: Number(row.reply_count),
      open_report_count: Number(row.open_report_count),
    };
  }

  // Removes visible content, or takes over a moderator's removal so that the
  // community's moderators can no longer restore it. 409 when an
  // administrator already removed it.
  removePost(
    id: string,
    input: AdminReasonDto,
    actorId: string,
  ): Promise<AdminPostDetail> {
    return inTransaction(this.pool, async (connection) => {
      const post = await this.lock(connection, LOCK_POST_SQL, id, 'Post');
      await this.remove(connection, 'post', post, input.reason, actorId, {
        post_title: post.title ?? '',
      });
      return this.findPost(id, connection);
    });
  }

  removeComment(
    id: string,
    input: AdminReasonDto,
    actorId: string,
  ): Promise<AdminCommentDetail> {
    return inTransaction(this.pool, async (connection) => {
      const comment = await this.lock(
        connection,
        LOCK_COMMENT_SQL,
        id,
        'Comment',
      );
      await this.remove(connection, 'comment', comment, input.reason, actorId, {
        excerpt: comment.content ?? '',
      });
      return this.findComment(id, connection);
    });
  }

  // Restores any removal, a moderator's included. 409 unless removed.
  restorePost(
    id: string,
    input: AdminReasonDto,
    actorId: string,
  ): Promise<AdminPostDetail> {
    return inTransaction(this.pool, async (connection) => {
      const post = await this.lock(connection, LOCK_POST_SQL, id, 'Post');
      await this.restore(connection, 'post', post, input.reason, actorId);
      return this.findPost(id, connection);
    });
  }

  // 409 while the comment's post is removed, as for moderators: restoring
  // it would succeed into a thread nobody but reviewers can see.
  restoreComment(
    id: string,
    input: AdminReasonDto,
    actorId: string,
  ): Promise<AdminCommentDetail> {
    return inTransaction(this.pool, async (connection) => {
      const comment = await this.lock(
        connection,
        LOCK_COMMENT_SQL,
        id,
        'Comment',
      );
      if (comment.removed_at !== null && comment.post_removed_at) {
        throw new ConflictException(
          'The post of this comment is removed; restore the post first',
        );
      }
      await this.restore(connection, 'comment', comment, input.reason, actorId);
      return this.findComment(id, connection);
    });
  }

  private async lock(
    connection: PoolConnection,
    sql: string,
    id: string,
    kind: 'Post' | 'Comment',
  ): Promise<LockedContentRow> {
    const [rows] = await connection.execute<LockedContentRow[]>(sql, [id]);
    if (!rows[0]) {
      throw new NotFoundException(`${kind} not found`);
    }
    return rows[0];
  }

  private async remove(
    connection: PoolConnection,
    kind: 'post' | 'comment',
    row: LockedContentRow,
    reason: string,
    actorId: string,
    snapshot: { post_title: string } | { excerpt: string },
  ): Promise<void> {
    const previous = stateOf(row);
    if (previous === 'admin_removed') {
      throw new ConflictException(
        `This ${kind} is already removed by an administrator`,
      );
    }
    const [result] = await connection.execute<ResultSetHeader>(
      ADMIN_REMOVE_SQL(kind === 'post' ? 'posts' : 'comments'),
      [actorId, reason, row.id],
    );
    if (result.affectedRows !== 1) {
      throw new ConflictException(`The ${kind} changed concurrently`);
    }
    // A moderator's removal already told the author; the takeover changes
    // nothing they can see. Never the reason or the administrator (#44).
    if (previous === 'visible' && row.author_id !== actorId) {
      await this.notifications.record(connection, {
        recipientId: row.author_id,
        type: 'content_removed',
        actorId: null,
        subjectType: kind,
        subjectId: row.id,
        communityId: row.community_id,
        metadata: snapshot,
      });
    }
    // The removal answers the community's open reports of the content, as a
    // moderator's does; the administrator's audit entry is the record, so
    // nothing is written to the community's moderation log.
    await connection.execute<ResultSetHeader>(CLOSE_COMMUNITY_REPORTS_SQL, [
      'removed',
      actorId,
      row.community_id,
      kind,
      row.id,
    ]);
    await this.auditLog.record(
      connection,
      contentAuditEntry(kind, 'removed', actorId, row.id, {
        community_name: row.community_name,
        previous_state: previous,
        reason,
      }),
    );
  }

  private async restore(
    connection: PoolConnection,
    kind: 'post' | 'comment',
    row: LockedContentRow,
    reason: string,
    actorId: string,
  ): Promise<void> {
    const previous = stateOf(row);
    if (previous === 'visible') {
      throw new ConflictException(`This ${kind} is not removed`);
    }
    const [result] = await connection.execute<ResultSetHeader>(
      ADMIN_RESTORE_SQL(kind === 'post' ? 'posts' : 'comments'),
      [row.id],
    );
    if (result.affectedRows !== 1) {
      throw new ConflictException(`The ${kind} changed concurrently`);
    }
    await this.auditLog.record(
      connection,
      contentAuditEntry(kind, 'restored', actorId, row.id, {
        community_name: row.community_name,
        previous_state: previous,
        reason,
      }),
    );
  }

  private filters(
    alias: 'p' | 'cm',
    query: ListAdminPostsDto | ListAdminCommentsDto,
    searchColumn: string,
  ): { where: string[]; values: string[] } {
    const where: string[] = [];
    const values: string[] = [];
    const search = query.search?.trim();
    if (search) {
      where.push(`LOWER(${searchColumn}) LIKE LOWER(?) ESCAPE '='`);
      values.push(`%${escapeLikeSearch(search)}%`);
    }
    if (query.community_id) {
      where.push('c.id = ?');
      values.push(query.community_id);
    }
    if (query.author_username) {
      where.push('author.username = ?');
      values.push(query.author_username);
    }
    const state = query.state ?? 'any';
    if (state !== 'any') {
      where.push(stateFilter(alias)[state]);
    }
    const communityState = query.community_state ?? 'any';
    if (communityState !== 'any') {
      where.push(COMMUNITY_STATE_FILTER[communityState]);
    }
    return { where, values };
  }

  // idx_posts_created and idx_comments_created (migration 041) serve the
  // order; the id tiebreaker makes it total.
  private async page<T extends RowDataPacket>(
    columns: string,
    from: string,
    alias: 'p' | 'cm',
    where: string[],
    values: string[],
    query: { page?: number; limit?: number; sort?: 'new' | 'oldest' },
  ): Promise<[T[], number]> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const clause = where.length ? `\n       WHERE ${where.join(' AND ')}` : '';
    const direction = query.sort === 'oldest' ? 'ASC' : 'DESC';
    const [rows] = await this.pool.execute<T[]>(
      `SELECT ${columns}
       ${from}${clause}
       ORDER BY ${alias}.created_at ${direction}, ${alias}.id ${direction} LIMIT ? OFFSET ?`,
      [...values, limit, (page - 1) * limit],
    );
    const [count] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total ${from}${clause}`, values);
    return [rows, Number(count[0]?.total ?? 0)];
  }

  private list<T>(
    items: T[],
    total: number,
    query: ListAdminPostsDto | ListAdminCommentsDto,
    extra: Record<string, string | null>,
  ): AdminContentList<T> {
    return {
      items,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      total,
      filters: {
        search: query.search ?? null,
        community_id: query.community_id ?? null,
        author_username: query.author_username ?? null,
        state: query.state ?? 'any',
        community_state: query.community_state ?? 'any',
        sort: query.sort ?? 'new',
        ...extra,
      },
    };
  }
}
