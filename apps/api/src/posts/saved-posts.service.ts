import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { listedCommunitySql } from '../common/community-visibility';
import type {
  ListSavedPostsDto,
  SavedPostSort,
} from './dto/list-saved-posts.dto';
import {
  POST_COLUMNS,
  toPostDtos,
  type PostDto,
  type PostRow,
} from './posts.service';

export interface SavedPostDto {
  post: PostDto;
  saved_at: string;
}

export interface SavedPostListDto {
  items: SavedPostDto[];
  page: number;
  limit: number;
  total: number;
  sort: SavedPostSort;
}

interface SavedPostRow extends PostRow {
  saved_at: Date | string;
}

// A post may be saved only while it is readable: not removed by moderation
// and in a community that is neither deleted nor suspended. Same predicate
// as the listing, so nothing can be saved that the list would hide.
export const SAVEABLE_POST_SQL = `SELECT id FROM posts WHERE id = ? AND posts.removed_at IS NULL AND ${listedCommunitySql('posts.community_id')} LIMIT 1`;

// Unsaving needs only the post to exist, in any state: a user may always
// drop a bookmark, including one to a post that has since been hidden.
export const ANY_POST_SQL = 'SELECT id FROM posts WHERE id = ? LIMIT 1';

export const SAVE_POST_SQL =
  'INSERT INTO saved_posts (user_id, post_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE created_at = created_at';

export const UNSAVE_POST_SQL =
  'DELETE FROM saved_posts WHERE user_id = ? AND post_id = ?';

// The listing's FROM and WHERE, shared verbatim by the page and its total,
// so the count can never disagree with what the pages return. A save stays
// a row while its post is removed or its community deleted or suspended:
// those posts are omitted here, not deleted, so a restored post reappears.
// A post whose author deleted their account is kept: it is still readable
// under the placeholder username. STRAIGHT_JOIN keeps saved_posts first, so
// the order is idx_saved_posts_user_created's.
export const SAVED_POSTS_FROM = `FROM saved_posts s
       STRAIGHT_JOIN posts p ON p.id = s.post_id
       WHERE s.user_id = ?
         AND p.removed_at IS NULL
         AND ${listedCommunitySql('p.community_id')}`;

const PREFIXED_POST_COLUMNS = POST_COLUMNS.split(', ')
  .map((column) => `p.${column}`)
  .join(', ');

// Ordered by when the post was saved, not when it was posted: a bookmark
// list is read in the order you kept things. post_id is the tiebreaker.
export const savedPostsSql = (sort: SavedPostSort): string => {
  const direction = sort === 'oldest' ? 'ASC' : 'DESC';
  return `SELECT ${PREFIXED_POST_COLUMNS}, s.created_at AS saved_at
       ${SAVED_POSTS_FROM}
       ORDER BY s.created_at ${direction}, s.post_id ${direction}
       LIMIT ? OFFSET ?`;
};

export const SAVED_POSTS_COUNT_SQL = `SELECT COUNT(*) AS total ${SAVED_POSTS_FROM}`;

// Saves are private: every statement is bound to the caller's id from the
// token, no route takes a user parameter, and no response carries a save
// count. Saving is not participation (it adds nothing to a community), so it
// is not gated on community rule acceptance.
@Injectable()
export class SavedPostsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // Idempotent: a repeat save leaves one row and keeps its created_at, the
  // listing's order key.
  async save(postId: string, userId: string): Promise<void> {
    await this.ensurePost(SAVEABLE_POST_SQL, postId);
    await this.pool.execute<ResultSetHeader>(SAVE_POST_SQL, [userId, postId]);
  }

  // Idempotent: removing a save that does not exist is still a success.
  async unsave(postId: string, userId: string): Promise<void> {
    await this.ensurePost(ANY_POST_SQL, postId);
    await this.pool.execute<ResultSetHeader>(UNSAVE_POST_SQL, [userId, postId]);
  }

  async list(
    userId: string,
    query: ListSavedPostsDto,
  ): Promise<SavedPostListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sort = query.sort ?? 'new';
    const offset = (page - 1) * limit;

    const [rows] = await this.pool.execute<SavedPostRow[]>(
      savedPostsSql(sort),
      [userId, limit, offset],
    );
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(SAVED_POSTS_COUNT_SQL, [userId]);
    // Every listed post is the caller's saved post: no lookup needed.
    const posts = await toPostDtos(this.pool, rows, userId, true);

    return {
      items: rows.map((row, index) => ({
        post: posts[index],
        saved_at: new Date(row.saved_at).toISOString(),
      })),
      page,
      limit,
      total: Number(counts[0]?.total ?? 0),
      sort,
    };
  }

  private async ensurePost(sql: string, postId: string): Promise<void> {
    const [posts] = await this.pool.execute<(RowDataPacket & { id: string })[]>(
      sql,
      [postId],
    );
    if (!posts[0]) {
      throw new NotFoundException('Post not found');
    }
  }
}
