import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { readableCommunitySql } from '../common/community-visibility';
import type { UserCommentDto } from '../users/user-activity.service';
import { loadVoteScores } from '../votes/vote-scores';
import type { ListOwnContentDto, OwnListSort } from './dto/own-content.dto';

export interface SavedCommentDto {
  comment: UserCommentDto;
  saved_at: string;
}

export interface SavedCommentListDto {
  items: SavedCommentDto[];
  page: number;
  limit: number;
  total: number;
  sort: OwnListSort;
}

// A flat comment with its post and community for context, as the author
// listings and search render it.
export const FLAT_COMMENT_COLUMNS =
  'c.id, c.post_id, c.content, c.created_at, c.edited_at, p.title AS post_title, co.name AS community_name';

export interface FlatCommentRow extends RowDataPacket {
  id: string;
  post_id: string;
  content: string;
  created_at: Date | string;
  edited_at: Date | string | null;
  post_title: string;
  community_name: string;
}

export async function toFlatCommentDtos(
  executor: Pick<Pool | PoolConnection, 'execute'>,
  rows: FlatCommentRow[],
): Promise<UserCommentDto[]> {
  const scores = await loadVoteScores(
    executor,
    'comment',
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    post_id: row.post_id,
    content: row.content,
    created_at: new Date(row.created_at).toISOString(),
    edited_at: row.edited_at ? new Date(row.edited_at).toISOString() : null,
    post_title: row.post_title,
    community_name: row.community_name,
    score: scores.get(row.id) ?? 0,
  }));
}

// A comment may be saved only while a reader could see it: neither it nor
// its post removed, its community visible and readable by the caller.
// Values: comment id, the caller.
export const SAVEABLE_COMMENT_SQL = `SELECT comments.id FROM comments
       INNER JOIN posts ON posts.id = comments.post_id
       WHERE comments.id = ? AND comments.removed_at IS NULL
         AND posts.removed_at IS NULL
         AND ${readableCommunitySql('posts.community_id')}
       LIMIT 1`;

// Unsaving needs only the comment to exist, in any state.
export const ANY_COMMENT_SQL = 'SELECT id FROM comments WHERE id = ? LIMIT 1';

export const SAVE_COMMENT_SQL =
  'INSERT INTO saved_comments (user_id, comment_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE created_at = created_at';
export const UNSAVE_COMMENT_SQL =
  'DELETE FROM saved_comments WHERE user_id = ? AND comment_id = ?';

// Exactly as saved posts: a save stays a row while its comment, its post or
// its community is hidden, and is omitted here; a deleted comment takes its
// saves with it (CASCADE). Values: the caller, twice.
export const SAVED_COMMENTS_FROM = `FROM saved_comments s
       STRAIGHT_JOIN comments c ON c.id = s.comment_id
       STRAIGHT_JOIN posts p ON p.id = c.post_id
       STRAIGHT_JOIN communities co ON co.id = p.community_id
       WHERE s.user_id = ?
         AND c.removed_at IS NULL
         AND p.removed_at IS NULL
         AND ${readableCommunitySql('p.community_id')}`;

export const savedCommentsSql = (sort: OwnListSort): string => {
  const direction = sort === 'oldest' ? 'ASC' : 'DESC';
  return `SELECT ${FLAT_COMMENT_COLUMNS}, s.created_at AS saved_at
       ${SAVED_COMMENTS_FROM}
       ORDER BY s.created_at ${direction}, s.comment_id ${direction}
       LIMIT ? OFFSET ?`;
};

export const SAVED_COMMENTS_COUNT_SQL = `SELECT COUNT(*) AS total ${SAVED_COMMENTS_FROM}`;

// A user's private comment bookmarks, the counterpart of SavedPostsService.
@Injectable()
export class SavedCommentsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async save(commentId: string, userId: string): Promise<void> {
    await this.ensureComment(SAVEABLE_COMMENT_SQL, [commentId, userId]);
    await this.pool.execute<ResultSetHeader>(SAVE_COMMENT_SQL, [
      userId,
      commentId,
    ]);
  }

  async unsave(commentId: string, userId: string): Promise<void> {
    await this.ensureComment(ANY_COMMENT_SQL, [commentId]);
    await this.pool.execute<ResultSetHeader>(UNSAVE_COMMENT_SQL, [
      userId,
      commentId,
    ]);
  }

  async list(
    userId: string,
    query: ListOwnContentDto,
  ): Promise<SavedCommentListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sort = query.sort ?? 'new';
    const [rows] = await this.pool.execute<
      (FlatCommentRow & { saved_at: Date | string })[]
    >(savedCommentsSql(sort), [userId, userId, limit, (page - 1) * limit]);
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(SAVED_COMMENTS_COUNT_SQL, [userId, userId]);
    const comments = await toFlatCommentDtos(this.pool, rows);
    return {
      items: rows.map((row, index) => ({
        comment: comments[index],
        saved_at: new Date(row.saved_at).toISOString(),
      })),
      page,
      limit,
      total: Number(counts[0]?.total ?? 0),
      sort,
    };
  }

  private async ensureComment(sql: string, values: string[]): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, values);
    if (!rows[0]) {
      throw new NotFoundException('Comment not found');
    }
  }
}
