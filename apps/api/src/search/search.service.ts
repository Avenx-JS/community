import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  COMMUNITY_VISIBLE_PREDICATE,
  visibleCommunityColumnsSql,
  visibleCommunitySql,
} from '../common/community-visibility';
import { escapeLikeSearch } from '../common/like-search';
import type { CommunityDto } from '../communities/communities.service';
import {
  POST_COLUMNS,
  toPostDtos,
  type PostDto,
  type PostRow,
} from '../posts/posts.service';
import {
  USER_ID_BY_USERNAME_SQL,
  type UserCommentDto,
} from '../users/user-activity.service';
import type { UserProfile } from '../users/users.service';
import { loadVoteScores } from '../votes/vote-scores';
import { loadMediaByIds } from '../media/media-dto';
import type {
  SearchQueryDto,
  SearchSort,
  SearchType,
} from './dto/search-query.dto';
import { booleanModeTerms } from './search-terms';

// One result kind per request (type is required): a response mixing four kinds
// would cost four queries, have four paginations that cannot be combined, and
// no meaningful relevance order across them.
export interface SearchResults<T> {
  type: SearchType;
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export type SearchItem = UserProfile | CommunityDto | PostDto | UserCommentDto;

// Each MATCH column list is exactly its FULLTEXT index's (migration 015), or
// MySQL cannot use the index. Never edit one without the other.
export const POSTS_MATCH_SQL =
  'MATCH (posts.title, posts.content) AGAINST (? IN BOOLEAN MODE)';
export const COMMENTS_MATCH_SQL =
  'MATCH (c.content) AGAINST (? IN BOOLEAN MODE)';
export const COMMUNITIES_MATCH_SQL =
  'MATCH (communities.name, communities.description) AGAINST (? IN BOOLEAN MODE)';

// The community a content filter names, if a reader could see it: a deleted
// or suspended community is as unknown here as anywhere public.
export const SEARCH_COMMUNITY_ID_SQL = `SELECT id FROM communities WHERE name = ? AND ${COMMUNITY_VISIBLE_PREDICATE} LIMIT 1`;

interface Query {
  // FROM and WHERE, shared by the page and its count so the two cannot differ.
  from: string;
  values: Bind[];
}

interface CommentRow extends RowDataPacket {
  id: string;
  post_id: string;
  content: string;
  created_at: Date | string;
  edited_at: Date | string | null;
  post_title: string;
  community_name: string;
}

interface UserRow extends RowDataPacket {
  username: string;
  display_name: string | null;
  bio: string | null;
  created_at: Date | string;
  avatar_media_id?: string | null;
}

interface CommunityRow extends RowDataPacket {
  id: string;
  creator_id: string;
  name: string;
  description: string | null;
  created_at: Date | string;
}

type TotalRow = RowDataPacket & { total: number | string };
type Bind = string | number;

// The same UTC reading of an ISO 8601 bound as the admin report queue.
function toUtcSqlDate(value: string): string {
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  return new Date(withZone).toISOString().slice(0, 19).replace('T', ' ');
}

const iso = (value: Date | string) => new Date(value).toISOString();

@Injectable()
export class SearchService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async search(
    query: SearchQueryDto,
    viewerId?: string,
  ): Promise<SearchResults<SearchItem>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const sort = query.sort ?? 'relevance';
    const envelope = { type: query.type, page, limit };

    switch (query.type) {
      case 'users': {
        const { items, total } = await this.users(query.q, sort, limit, offset);
        return { ...envelope, items, total };
      }
      case 'communities': {
        const { items, total } = await this.communities(
          booleanModeTerms(query.q),
          sort,
          limit,
          offset,
        );
        return { ...envelope, items, total };
      }
      case 'posts': {
        const { items, total } = await this.posts(
          query,
          sort,
          limit,
          offset,
          viewerId,
        );
        return { ...envelope, items, total };
      }
      case 'comments': {
        const { items, total } = await this.comments(
          query,
          sort,
          limit,
          offset,
        );
        return { ...envelope, items, total };
      }
    }
  }

  // A prefix match on the UNIQUE index over username: no leading wildcard, so
  // the index serves it, and no FULLTEXT index on users (migration 015). The
  // column's case-insensitive collation makes the match case-insensitive
  // without LOWER(), which would defeat the index. Only username is matched:
  // never email, display name or bio. relevance means prefix, then
  // alphabetical, which is what username order already is.
  private async users(
    q: string,
    sort: SearchSort,
    limit: number,
    offset: number,
  ) {
    const query: Query = {
      from: `FROM users
       WHERE username LIKE CONCAT(?, '%') ESCAPE '=' AND deleted_at IS NULL`,
      values: [escapeLikeSearch(q)],
    };
    const order =
      sort === 'new' ? 'created_at DESC, username ASC' : 'username ASC';
    const [rows] = await this.pool.execute<UserRow[]>(
      `SELECT username, display_name, bio, created_at, avatar_media_id ${query.from}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...query.values, limit, offset],
    );
    // The page's avatars in one statement, none without avatars.
    const avatars = await loadMediaByIds(
      this.pool,
      rows.map((row) => row.avatar_media_id),
    );
    return {
      items: rows.map((row): UserProfile => ({
        username: row.username,
        display_name: row.display_name,
        bio: row.bio,
        created_at: iso(row.created_at),
        avatar:
          (row.avatar_media_id && avatars.get(row.avatar_media_id)) || null,
      })),
      total: await this.count(query),
    };
  }

  private async communities(
    terms: string,
    sort: SearchSort,
    limit: number,
    offset: number,
  ) {
    const query: Query = {
      from: `FROM communities
       WHERE ${COMMUNITIES_MATCH_SQL}
         AND ${visibleCommunityColumnsSql('communities')}`,
      values: [terms],
    };
    const { select, order, values } = this.ranking(
      sort,
      terms,
      COMMUNITIES_MATCH_SQL,
      'communities',
    );
    const [rows] = await this.pool.execute<CommunityRow[]>(
      `SELECT communities.id, communities.creator_id, communities.name,
         communities.description, communities.created_at${select}
       ${query.from}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...values, ...query.values, limit, offset],
    );
    return {
      items: rows.map((row): CommunityDto => ({
        id: row.id,
        creator_id: row.creator_id,
        name: row.name,
        description: row.description,
        created_at: iso(row.created_at),
      })),
      total: await this.count(query),
    };
  }

  // What a reader of the community could see, as in the author listings: not
  // removed by a moderator, not in a deleted or suspended community.
  private async posts(
    input: SearchQueryDto,
    sort: SearchSort,
    limit: number,
    offset: number,
    viewerId?: string,
  ) {
    const terms = booleanModeTerms(input.q);
    const filters = await this.contentFilters(input, {
      community: 'posts.community_id',
      author: 'posts.author_id',
      createdAt: 'posts.created_at',
    });
    const query: Query = {
      from: `FROM posts
       WHERE ${POSTS_MATCH_SQL}
         AND posts.removed_at IS NULL
         AND ${visibleCommunitySql('posts.community_id')}${filters.sql}`,
      values: [terms, ...filters.values],
    };
    const { select, order, values } = this.ranking(
      sort,
      terms,
      POSTS_MATCH_SQL,
      'posts',
    );
    const columns = POST_COLUMNS.split(', ')
      .map((column) => `posts.${column}`)
      .join(', ');
    const [rows] = await this.pool.execute<PostRow[]>(
      `SELECT ${columns}${select}
       ${query.from}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...values, ...query.values, limit, offset],
    );
    return {
      items: await toPostDtos(this.pool, rows, viewerId),
      total: await this.count(query),
    };
  }

  // Flat items with their post and community for context, never the
  // recursive thread node: a search hit has no place in a tree. A comment on
  // a removed post is hidden with it.
  private async comments(
    input: SearchQueryDto,
    sort: SearchSort,
    limit: number,
    offset: number,
  ) {
    const terms = booleanModeTerms(input.q);
    const filters = await this.contentFilters(input, {
      community: 'p.community_id',
      author: 'c.author_id',
      createdAt: 'c.created_at',
    });
    const query: Query = {
      from: `FROM comments c
       JOIN posts p ON p.id = c.post_id
       JOIN communities co ON co.id = p.community_id
       WHERE ${COMMENTS_MATCH_SQL}
         AND c.removed_at IS NULL
         AND p.removed_at IS NULL
         AND ${visibleCommunityColumnsSql('co')}${filters.sql}`,
      values: [terms, ...filters.values],
    };
    const { select, order, values } = this.ranking(
      sort,
      terms,
      COMMENTS_MATCH_SQL,
      'c',
    );
    const [rows] = await this.pool.execute<CommentRow[]>(
      `SELECT c.id, c.post_id, c.content, c.created_at, c.edited_at,
         p.title AS post_title, co.name AS community_name${select}
       ${query.from}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...values, ...query.values, limit, offset],
    );
    const scores = await loadVoteScores(
      this.pool,
      'comment',
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row): UserCommentDto => ({
        id: row.id,
        post_id: row.post_id,
        content: row.content,
        created_at: iso(row.created_at),
        edited_at: row.edited_at === null ? null : iso(row.edited_at),
        post_title: row.post_title,
        community_name: row.community_name,
        score: scores.get(row.id) ?? 0,
      })),
      total: await this.count(query),
    };
  }

  // relevance orders by the match score, newest-first is created_at; both
  // break ties on id, so a page boundary never repeats or skips a row.
  private ranking(
    sort: SearchSort,
    terms: string,
    match: string,
    table: string,
  ): { select: string; order: string; values: Bind[] } {
    if (sort === 'new') {
      return {
        select: '',
        order: `${table}.created_at DESC, ${table}.id DESC`,
        values: [],
      };
    }
    return {
      select: `, ${match} AS relevance`,
      order: `relevance DESC, ${table}.id DESC`,
      values: [terms],
    };
  }

  // community and author resolve first: an unknown, deleted or suspended
  // community, and an unknown or deleted author, are 404s, as on
  // GET /communities/:name/posts and GET /users/:username/posts.
  private async contentFilters(
    input: SearchQueryDto,
    columns: { community: string; author: string; createdAt: string },
  ): Promise<{ sql: string; values: Bind[] }> {
    const clauses: string[] = [];
    const values: Bind[] = [];
    if (input.community !== undefined) {
      clauses.push(`${columns.community} = ?`);
      values.push(
        await this.idOf(SEARCH_COMMUNITY_ID_SQL, input.community, 'Community'),
      );
    }
    if (input.author !== undefined) {
      clauses.push(`${columns.author} = ?`);
      values.push(
        await this.idOf(USER_ID_BY_USERNAME_SQL, input.author, 'User'),
      );
    }
    if (input.from !== undefined) {
      clauses.push(
        `${columns.createdAt} >= CONVERT_TZ(?, '+00:00', @@session.time_zone)`,
      );
      values.push(toUtcSqlDate(input.from));
    }
    if (input.to !== undefined) {
      clauses.push(
        `${columns.createdAt} < CONVERT_TZ(?, '+00:00', @@session.time_zone)`,
      );
      values.push(toUtcSqlDate(input.to));
    }
    return {
      sql: clauses.map((clause) => `\n         AND ${clause}`).join(''),
      values,
    };
  }

  private async idOf(sql: string, key: string, kind: string): Promise<string> {
    const [rows] = await this.pool.execute<(RowDataPacket & { id: string })[]>(
      sql,
      [key],
    );
    if (!rows[0]) {
      throw new NotFoundException(`${kind} not found`);
    }
    return rows[0].id;
  }

  private async count(query: Query): Promise<number> {
    const [rows] = await this.pool.execute<TotalRow[]>(
      `SELECT COUNT(*) AS total ${query.from}`,
      query.values,
    );
    return Number(rows[0]?.total ?? 0);
  }
}
