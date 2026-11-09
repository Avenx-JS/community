import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  MEMBERS_JOIN,
  MEMBERS_WHERE,
  MODERATORS_FROM,
} from './communities.service';
import { COMMUNITY_VISIBLE_PREDICATE } from '../common/community-visibility';

// The recent-activity window, fixed in the server: a public summary takes no
// caller-supplied range (see README, "Community statistics").
export const STATS_WINDOW_DAYS = 7;

// The window's start on the database clock. UTC_TIMESTAMP() minus the window,
// converted to the session time zone that TIMESTAMP columns are compared in,
// so the bound is right whatever the session zone. A constant, so the
// created_at range stays index-served.
export const WINDOW_START = `CONVERT_TZ(
         DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${STATS_WINDOW_DAYS} DAY),
         '+00:00', @@session.time_zone
       )`;

// Each aggregate is bound to the resolved community id, never the name.
// Members and moderators reuse the lists' definitions, so the counts equal
// GET /communities/:name/members and /moderators totals.
export const MEMBER_COUNT_SQL = `SELECT COUNT(*) AS total ${MEMBERS_JOIN} WHERE ${MEMBERS_WHERE}`;
export const MODERATOR_COUNT_SQL = `SELECT COUNT(*) AS total ${MODERATORS_FROM}`;
// One range read of idx_posts_community_created (community_id, created_at,
// id) serves all three post figures.
export const POST_STATS_SQL = `SELECT COUNT(*) AS total,
         MAX(created_at) AS last_post_at,
         COALESCE(SUM(created_at >= ${WINDOW_START}), 0) AS recent
       FROM posts
       WHERE community_id = ? AND removed_at IS NULL`;
// comments has no community column, so the count joins through posts: the
// community's posts from idx_posts_community_created, then each post's
// comments from idx_comments_post_created (post_id, created_at, id). The cost
// is bounded by the community's post count; denormalising
// comments.community_id is the documented escalation, not taken here.
export const COMMENT_STATS_SQL = `SELECT COUNT(*) AS total,
         COALESCE(SUM(c.created_at >= ${WINDOW_START}), 0) AS recent
       FROM posts p
       JOIN comments c ON c.post_id = p.id
       WHERE p.community_id = ?
         AND p.removed_at IS NULL
         AND c.removed_at IS NULL`;

interface CountRow extends RowDataPacket {
  total: number | string;
}

interface WindowedCountRow extends CountRow {
  recent: number | string;
}

interface PostStatsRow extends WindowedCountRow {
  last_post_at: Date | string | null;
}

export interface CommunityStatsDto {
  member_count: number;
  moderator_count: number;
  post_count: number;
  comment_count: number;
  created_at: string;
  last_post_at: string | null;
  posts_last_7_days: number;
  comments_last_7_days: number;
}

@Injectable()
export class CommunityStatsService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // Counts only, no per-row data. Not cached: each statement is index-served
  // and the global read rate limits bound abuse.
  async get(name: string): Promise<CommunityStatsDto> {
    const [communities] = await this.pool.execute<
      (RowDataPacket & {
        id: string;
        creator_id: string;
        created_at: Date | string;
      })[]
    >(
      `SELECT id, creator_id, created_at FROM communities WHERE name = ? AND ${COMMUNITY_VISIBLE_PREDICATE} LIMIT 1`,
      [name],
    );
    const community = communities[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const [[members], [moderators], [posts], [comments]] = await Promise.all([
      this.pool.execute<CountRow[]>(MEMBER_COUNT_SQL, [community.id]),
      this.pool.execute<CountRow[]>(MODERATOR_COUNT_SQL, [
        community.id,
        community.creator_id,
      ]),
      this.pool.execute<PostStatsRow[]>(POST_STATS_SQL, [community.id]),
      this.pool.execute<WindowedCountRow[]>(COMMENT_STATS_SQL, [community.id]),
    ]);
    const lastPostAt = posts[0]?.last_post_at ?? null;

    return {
      member_count: Number(members[0]?.total ?? 0),
      moderator_count: Number(moderators[0]?.total ?? 0),
      post_count: Number(posts[0]?.total ?? 0),
      comment_count: Number(comments[0]?.total ?? 0),
      created_at: new Date(community.created_at).toISOString(),
      last_post_at:
        lastPostAt === null ? null : new Date(lastPostAt).toISOString(),
      posts_last_7_days: Number(posts[0]?.recent ?? 0),
      comments_last_7_days: Number(comments[0]?.recent ?? 0),
    };
  }
}
