import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { readableCommunitySql } from '../common/community-visibility';
import type { UserCommentDto } from '../users/user-activity.service';
import type { ListVotedDto, VotedType } from './dto/own-content.dto';
import {
  POST_COLUMNS,
  toPostDtos,
  type PostDto,
  type PostRow,
} from './posts.service';
import {
  FLAT_COMMENT_COLUMNS,
  toFlatCommentDtos,
  type FlatCommentRow,
} from './saved-comments.service';

export type VoteDirection = 1 | -1;

export interface VotedItemDto {
  post?: PostDto;
  comment?: UserCommentDto;
  voted_at: string;
}

export interface VotedListDto {
  type: VotedType;
  items: VotedItemDto[];
  page: number;
  limit: number;
  total: number;
}

// The caller's votes of one direction on content a reader could still see:
// removed content, content under a removed post, and content in a deleted,
// suspended or (for a non-member) private community are omitted, and the
// vote rows are kept. Served by idx_votes_user_value (migration 039), newest
// vote first. Values: the caller, the direction, the caller again.
export const VOTED_POSTS_FROM = `FROM votes v
       STRAIGHT_JOIN posts p ON p.id = v.target_id
       WHERE v.user_id = ? AND v.target_type = 'post' AND v.value = ?
         AND p.removed_at IS NULL
         AND ${readableCommunitySql('p.community_id')}`;

export const VOTED_COMMENTS_FROM = `FROM votes v
       STRAIGHT_JOIN comments c ON c.id = v.target_id
       STRAIGHT_JOIN posts p ON p.id = c.post_id
       STRAIGHT_JOIN communities co ON co.id = p.community_id
       WHERE v.user_id = ? AND v.target_type = 'comment' AND v.value = ?
         AND c.removed_at IS NULL
         AND p.removed_at IS NULL
         AND ${readableCommunitySql('p.community_id')}`;

const PREFIXED_POST_COLUMNS = POST_COLUMNS.split(', ')
  .map((column) => `p.${column}`)
  .join(', ');
const ORDER = 'ORDER BY v.created_at DESC, v.id DESC LIMIT ? OFFSET ?';

export const VOTED_POSTS_SQL = `SELECT ${PREFIXED_POST_COLUMNS}, v.created_at AS voted_at
       ${VOTED_POSTS_FROM}
       ${ORDER}`;
export const VOTED_COMMENTS_SQL = `SELECT ${FLAT_COMMENT_COLUMNS}, v.created_at AS voted_at
       ${VOTED_COMMENTS_FROM}
       ${ORDER}`;
export const VOTED_POSTS_COUNT_SQL = `SELECT COUNT(*) AS total ${VOTED_POSTS_FROM}`;
export const VOTED_COMMENTS_COUNT_SQL = `SELECT COUNT(*) AS total ${VOTED_COMMENTS_FROM}`;

// GET /users/me/upvoted and /downvoted: private, bound to the caller from
// the token; no route takes a user parameter.
@Injectable()
export class VoteHistoryService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async list(
    userId: string,
    direction: VoteDirection,
    query: ListVotedDto,
  ): Promise<VotedListDto> {
    const type = query.type ?? 'posts';
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const values = [userId, direction, userId];
    const offset = (page - 1) * limit;
    const [counts] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(
      type === 'posts' ? VOTED_POSTS_COUNT_SQL : VOTED_COMMENTS_COUNT_SQL,
      values,
    );
    const total = Number(counts[0]?.total ?? 0);

    if (type === 'posts') {
      const [rows] = await this.pool.execute<
        (PostRow & { voted_at: Date | string })[]
      >(VOTED_POSTS_SQL, [...values, limit, offset]);
      const posts = await toPostDtos(this.pool, rows, userId);
      return {
        type,
        items: rows.map((row, index) => ({
          post: posts[index],
          voted_at: new Date(row.voted_at).toISOString(),
        })),
        page,
        limit,
        total,
      };
    }
    const [rows] = await this.pool.execute<
      (FlatCommentRow & { voted_at: Date | string })[]
    >(VOTED_COMMENTS_SQL, [...values, limit, offset]);
    const comments = await toFlatCommentDtos(this.pool, rows);
    return {
      type,
      items: rows.map((row, index) => ({
        comment: comments[index],
        voted_at: new Date(row.voted_at).toISOString(),
      })),
      page,
      limit,
      total,
    };
  }
}
