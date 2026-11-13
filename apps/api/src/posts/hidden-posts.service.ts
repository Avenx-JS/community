import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { readableCommunitySql } from '../common/community-visibility';
import type { ListOwnContentDto, OwnListSort } from './dto/own-content.dto';
import {
  POST_COLUMNS,
  toPostDtos,
  type PostDto,
  type PostRow,
} from './posts.service';
import { ANY_POST_SQL, SAVEABLE_POST_SQL } from './saved-posts.service';

export interface HiddenPostDto {
  post: PostDto;
  hidden_at: string;
}

export interface HiddenPostListDto {
  items: HiddenPostDto[];
  page: number;
  limit: number;
  total: number;
  sort: OwnListSort;
}

export const HIDE_POST_SQL =
  'INSERT INTO hidden_posts (user_id, post_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE created_at = created_at';
export const UNHIDE_POST_SQL =
  'DELETE FROM hidden_posts WHERE user_id = ? AND post_id = ?';

// The caller's hidden posts that a reader could still see, as the saved list
// filters them; a row survives a removal and reappears with a restore.
// Values: the caller, twice.
export const HIDDEN_POSTS_FROM = `FROM hidden_posts h
       STRAIGHT_JOIN posts p ON p.id = h.post_id
       WHERE h.user_id = ?
         AND p.removed_at IS NULL
         AND ${readableCommunitySql('p.community_id')}`;

const PREFIXED_POST_COLUMNS = POST_COLUMNS.split(', ')
  .map((column) => `p.${column}`)
  .join(', ');

export const hiddenPostsSql = (sort: OwnListSort): string => {
  const direction = sort === 'oldest' ? 'ASC' : 'DESC';
  return `SELECT ${PREFIXED_POST_COLUMNS}, h.created_at AS hidden_at
       ${HIDDEN_POSTS_FROM}
       ORDER BY h.created_at ${direction}, h.post_id ${direction}
       LIMIT ? OFFSET ?`;
};

export const HIDDEN_POSTS_COUNT_SQL = `SELECT COUNT(*) AS total ${HIDDEN_POSTS_FROM}`;

// Hiding is the caller's own view: it takes a post out of their GET /posts,
// /feed and /communities/:name/posts (NOT_HIDDEN_BY_VIEWER_SQL), never out of
// anyone else's, and the permalink stays reachable. Private: no route takes
// a user parameter and nothing counts hides.
@Injectable()
export class HiddenPostsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // Idempotent. Only a post the caller could read, as saving.
  async hide(postId: string, userId: string): Promise<void> {
    await this.ensurePost(SAVEABLE_POST_SQL, [postId, userId]);
    await this.pool.execute<ResultSetHeader>(HIDE_POST_SQL, [userId, postId]);
  }

  // Idempotent, and open for any existing post, removed or hidden ones too.
  async unhide(postId: string, userId: string): Promise<void> {
    await this.ensurePost(ANY_POST_SQL, [postId]);
    await this.pool.execute<ResultSetHeader>(UNHIDE_POST_SQL, [userId, postId]);
  }

  async list(
    userId: string,
    query: ListOwnContentDto,
  ): Promise<HiddenPostListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sort = query.sort ?? 'new';
    const [rows] = await this.pool.execute<
      (PostRow & { hidden_at: Date | string })[]
    >(hiddenPostsSql(sort), [userId, userId, limit, (page - 1) * limit]);
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(HIDDEN_POSTS_COUNT_SQL, [userId, userId]);
    const posts = await toPostDtos(this.pool, rows, userId);
    return {
      items: rows.map((row, index) => ({
        post: posts[index],
        hidden_at: new Date(row.hidden_at).toISOString(),
      })),
      page,
      limit,
      total: Number(counts[0]?.total ?? 0),
      sort,
    };
  }

  private async ensurePost(sql: string, values: string[]): Promise<void> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, values);
    if (!rows[0]) {
      throw new NotFoundException('Post not found');
    }
  }
}
