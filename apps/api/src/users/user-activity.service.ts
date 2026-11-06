import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { listedCommunitySql } from '../common/community-visibility';
import { loadVoteScores } from '../votes/vote-scores';
import {
  POST_COLUMNS,
  toPostDtos,
  type PostDto,
  type PostRow,
} from '../posts/posts.service';
import type {
  ListUserActivityDto,
  ListUserCommunitiesDto,
  UserActivitySort,
} from './dto/list-user-activity.dto';

// Public, read-only listings of what one account has written and where it
// takes part: GET /users/:username/posts, /comments and /communities.
//
// Every listing resolves the username first, so an unknown or deleted
// account is a 404 before any other rule applies; a deleted account's
// placeholder username never serves a feed of its retained content.
//
// What a listing shows is exactly what a reader of the community could see:
// nothing from a deleted or suspended community, nothing removed by a
// moderator, and no comment on a removed post.

export const USER_ID_BY_USERNAME_SQL =
  'SELECT id FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1';

// Served by idx_posts_author_created (author_id, created_at, id): rows come
// in index order, so neither direction needs a filesort.
const USER_POSTS_WHERE = `WHERE author_id = ? AND removed_at IS NULL AND ${listedCommunitySql('posts.community_id')}`;

export const userPostsSql = (sort: UserActivitySort): string =>
  `SELECT ${POST_COLUMNS} FROM posts ${USER_POSTS_WHERE} ORDER BY ${order(sort, 'created_at', 'id')} LIMIT ? OFFSET ?`;

export const USER_POSTS_COUNT_SQL = `SELECT COUNT(*) AS total FROM posts ${USER_POSTS_WHERE}`;

// The join to posts and communities supplies the link context. Unlike the
// notification inbox, which deliberately stores its context because its
// subjects may be gone, a comment's post always exists: comments.post_id is a
// real foreign key with ON DELETE CASCADE, and a post's community_id likewise,
// so the joins cannot drop or orphan a row. Served by
// idx_comments_author_created, joined to each post and community by primary
// key; STRAIGHT_JOIN keeps comments first so that order is the index order.
const USER_COMMENTS_FROM = `FROM comments c
       STRAIGHT_JOIN posts p ON p.id = c.post_id
       STRAIGHT_JOIN communities co ON co.id = p.community_id
       WHERE c.author_id = ?
         AND c.removed_at IS NULL
         AND p.removed_at IS NULL
         AND co.deleted_at IS NULL
         AND co.suspended_at IS NULL`;

export const userCommentsSql = (sort: UserActivitySort): string =>
  `SELECT c.id, c.post_id, c.content, c.created_at, c.edited_at,
              p.title AS post_title, co.name AS community_name
       ${USER_COMMENTS_FROM}
       ORDER BY ${order(sort, 'c.created_at', 'c.id')} LIMIT ? OFFSET ?`;

export const USER_COMMENTS_COUNT_SQL = `SELECT COUNT(*) AS total ${USER_COMMENTS_FROM}`;

// The communities whose own pages already reveal the person: those they
// created, moderate (GET /communities/:name/moderators is public), or wrote a
// visible post or comment in. A subscription alone is never listed: it would
// publish reading habits, which nothing else in the API exposes (see the
// README). Each branch starts from an index led by the user, so the cost
// grows with the person's activity, not with the number of communities.
const USER_COMMUNITY_IDS = `(
         SELECT id AS community_id FROM communities WHERE creator_id = ?
         UNION
         SELECT community_id FROM community_moderators WHERE user_id = ?
         UNION
         SELECT community_id FROM posts
         WHERE author_id = ? AND removed_at IS NULL
         UNION
         SELECT p.community_id FROM comments c
         JOIN posts p ON p.id = c.post_id
         WHERE c.author_id = ? AND c.removed_at IS NULL AND p.removed_at IS NULL
       ) activity
       JOIN communities co ON co.id = activity.community_id
       WHERE co.deleted_at IS NULL AND co.suspended_at IS NULL`;

// By name: deterministic, and unlike a recency order it does not reveal when
// the person was last active there. The strongest role wins.
export const USER_COMMUNITIES_SQL = `SELECT co.name, co.description,
         CASE
           WHEN co.creator_id = ? THEN 'creator'
           WHEN EXISTS (
             SELECT 1 FROM community_moderators m
             WHERE m.community_id = co.id AND m.user_id = ?
           ) THEN 'moderator'
           ELSE 'contributor'
         END AS role
       FROM ${USER_COMMUNITY_IDS}
       ORDER BY co.name ASC LIMIT ? OFFSET ?`;

export const USER_COMMUNITIES_COUNT_SQL = `SELECT COUNT(*) AS total FROM ${USER_COMMUNITY_IDS}`;

function order(sort: UserActivitySort, createdAt: string, id: string): string {
  const direction = sort === 'oldest' ? 'ASC' : 'DESC';
  return `${createdAt} ${direction}, ${id} ${direction}`;
}

export type UserCommunityRole = 'creator' | 'moderator' | 'contributor';

// A flat comment, not the recursive thread node (CommentDto with replies):
// an author listing has no tree, and nodes with empty replies would invite
// clients to treat every comment as a root.
export interface UserCommentDto {
  id: string;
  post_id: string;
  content: string;
  created_at: string;
  edited_at: string | null;
  post_title: string;
  community_name: string;
  // Sum of all vote values on the comment; 0 without votes.
  score: number;
}

export interface UserCommunityDto {
  name: string;
  description: string | null;
  role: UserCommunityRole;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

interface UserCommentRow extends RowDataPacket {
  id: string;
  post_id: string;
  content: string;
  created_at: Date | string;
  edited_at: Date | string | null;
  post_title: string;
  community_name: string;
}

interface UserCommunityRow extends RowDataPacket {
  name: string;
  description: string | null;
  role: UserCommunityRole;
}

type TotalRow = RowDataPacket & { total: number | string };

@Injectable()
export class UserActivityService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async listPosts(
    username: string,
    query: ListUserActivityDto,
    viewerId?: string,
  ): Promise<Page<PostDto>> {
    const userId = await this.resolve(username);
    const { page, limit, offset } = paging(query);
    const sort = query.sort ?? 'new';
    const [rows] = await this.pool.execute<PostRow[]>(userPostsSql(sort), [
      userId,
      limit,
      offset,
    ]);
    const total = await this.count(USER_POSTS_COUNT_SQL, [userId]);
    return {
      items: await toPostDtos(this.pool, rows, viewerId),
      page,
      limit,
      total,
    };
  }

  async listComments(
    username: string,
    query: ListUserActivityDto,
  ): Promise<Page<UserCommentDto>> {
    const userId = await this.resolve(username);
    const { page, limit, offset } = paging(query);
    const sort = query.sort ?? 'new';
    const [rows] = await this.pool.execute<UserCommentRow[]>(
      userCommentsSql(sort),
      [userId, limit, offset],
    );
    const total = await this.count(USER_COMMENTS_COUNT_SQL, [userId]);
    const scores = await loadVoteScores(
      this.pool,
      'comment',
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        post_id: row.post_id,
        content: row.content,
        created_at: new Date(row.created_at).toISOString(),
        edited_at: row.edited_at ? new Date(row.edited_at).toISOString() : null,
        post_title: row.post_title,
        community_name: row.community_name,
        score: scores.get(row.id) ?? 0,
      })),
      page,
      limit,
      total,
    };
  }

  async listCommunities(
    username: string,
    query: ListUserCommunitiesDto,
  ): Promise<Page<UserCommunityDto>> {
    const userId = await this.resolve(username);
    const { page, limit, offset } = paging(query);
    const activity = [userId, userId, userId, userId];
    const [rows] = await this.pool.execute<UserCommunityRow[]>(
      USER_COMMUNITIES_SQL,
      [userId, userId, ...activity, limit, offset],
    );
    const total = await this.count(USER_COMMUNITIES_COUNT_SQL, activity);
    return {
      items: rows.map((row) => ({
        name: row.name,
        description: row.description,
        role: row.role,
      })),
      page,
      limit,
      total,
    };
  }

  private async resolve(username: string): Promise<string> {
    const [users] = await this.pool.execute<(RowDataPacket & { id: string })[]>(
      USER_ID_BY_USERNAME_SQL,
      [username],
    );
    const user = users[0];
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user.id;
  }

  private async count(sql: string, values: string[]): Promise<number> {
    const [rows] = await this.pool.execute<TotalRow[]>(sql, values);
    return Number(rows[0]?.total ?? 0);
  }
}

function paging(query: { page?: number; limit?: number }) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  return { page, limit, offset: (page - 1) * limit };
}
