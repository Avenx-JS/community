import { Inject, Injectable } from '@nestjs/common';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import {
  communityMemberSql,
  listedCommunitySql,
  visibleCommunityColumnsSql,
} from '../common/community-visibility';
import { readPositiveInteger } from '../common/read-positive-integer';
import {
  COMMUNITY_COLUMNS,
  toCommunityDto,
  type CommunityDto,
  type CommunityRow,
} from './communities.service';
import { readCommunityRole } from './community-access';
import type { DiscoveryQueryDto } from './dto/community-discovery.dto';

export interface DiscoveredCommunityDto extends CommunityDto {
  activity: number;
  new_members: number;
}

export interface DiscoveredCommunityListDto {
  items: DiscoveredCommunityDto[];
}

type DiscoveredRow = CommunityRow & {
  activity: number | string;
  new_members: number | string;
};

const C_COLUMNS = COMMUNITY_COLUMNS.split(', ')
  .map((column) => `c.${column}`)
  .join(', ');

// Members gained in the last 7 days, for one listed community.
const NEW_MEMBERS_SQL = `(SELECT COUNT(*) FROM community_subscriptions recent_member
           WHERE recent_member.community_id = c.id
             AND recent_member.created_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAY)`;

// What discovery never shows: hidden and private communities, nsfw ones to
// a viewer who did not opt in, and the viewer's muted ones. One placeholder:
// the viewer, or null.
const DISCOVERABLE_SQL = `${visibleCommunityColumnsSql('c')}
         AND c.visibility <> 'private'
         AND ${listedCommunitySql('c', { muted: true })}`;

// Communities with posts in the last 24 hours or members in the last 7
// days, by that activity. Only communities with recent activity are read:
// the derived table starts from the recent rows, not from every community.
// Values: viewer, limit.
export const TRENDING_COMMUNITIES_SQL = `SELECT ${C_COLUMNS},
         COALESCE(recent_posts.activity, 0) AS activity,
         ${NEW_MEMBERS_SQL} AS new_members
       FROM (
         SELECT community_id FROM posts
         WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 1 DAY AND removed_at IS NULL
         UNION
         SELECT community_id FROM community_subscriptions
         WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAY
       ) recent
       JOIN communities c ON c.id = recent.community_id
       LEFT JOIN (
         SELECT community_id, COUNT(*) AS activity FROM posts
         WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL 1 DAY AND removed_at IS NULL
         GROUP BY community_id
       ) recent_posts ON recent_posts.community_id = c.id
       WHERE ${DISCOVERABLE_SQL}
       ORDER BY activity DESC, new_members DESC, c.id DESC
       LIMIT ?`;

// Communities the viewer's fellow members also belong to, by how many of
// them do. The fellow members are bounded (the most recent
// COMMUNITY_RECOMMENDATION_PEERS of them), so the cost does not grow with
// the size of the viewer's communities. Excludes communities the viewer is
// already a member of. Values: viewer, peer bound, viewer, viewer, limit.
export const RECOMMENDED_COMMUNITIES_SQL = `SELECT ${C_COLUMNS},
         COUNT(*) AS activity,
         ${NEW_MEMBERS_SQL} AS new_members
       FROM (
         SELECT peer.user_id FROM community_subscriptions mine
         JOIN community_subscriptions peer
           ON peer.community_id = mine.community_id AND peer.user_id <> mine.user_id
         WHERE mine.user_id = ?
         GROUP BY peer.user_id
         ORDER BY MAX(peer.created_at) DESC
         LIMIT ?
       ) peers
       JOIN community_subscriptions theirs ON theirs.user_id = peers.user_id
       JOIN communities c ON c.id = theirs.community_id
       CROSS JOIN (SELECT CAST(? AS CHAR(36)) AS id) viewer
       WHERE NOT ${communityMemberSql('c', 'viewer.id')}
         AND ${DISCOVERABLE_SQL}
       GROUP BY c.id
       ORDER BY activity DESC, c.id DESC
       LIMIT ?`;

// The fallback when fellow members suggest too little: the largest
// discoverable communities the viewer is not in. Values: viewer, viewer,
// limit.
export const POPULAR_COMMUNITIES_SQL = `SELECT ${C_COLUMNS},
         0 AS activity,
         ${NEW_MEMBERS_SQL} AS new_members
       FROM communities c
       CROSS JOIN (SELECT CAST(? AS CHAR(36)) AS id) viewer
       WHERE NOT ${communityMemberSql('c', 'viewer.id')}
         AND ${DISCOVERABLE_SQL}
       ORDER BY (SELECT COUNT(*) FROM community_subscriptions member WHERE member.community_id = c.id) DESC, c.id DESC
       LIMIT ?`;

export const MUTE_COMMUNITY_SQL =
  'INSERT IGNORE INTO community_mutes (user_id, community_id) VALUES (?, ?)';
export const UNMUTE_COMMUNITY_SQL =
  'DELETE FROM community_mutes WHERE user_id = ? AND community_id = ?';

function toDiscovered(row: DiscoveredRow): DiscoveredCommunityDto {
  return {
    ...toCommunityDto(row),
    activity: Number(row.activity),
    new_members: Number(row.new_members),
  };
}

// Finding communities, and hiding them: GET /communities/trending and
// /recommended, POST and DELETE /communities/:name/mute.
@Injectable()
export class CommunityDiscoveryService {
  private readonly peers = readPositiveInteger(
    'COMMUNITY_RECOMMENDATION_PEERS',
    1000,
  );

  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async trending(
    query: DiscoveryQueryDto,
    viewerId?: string,
  ): Promise<DiscoveredCommunityListDto> {
    const [rows] = await this.pool.execute<DiscoveredRow[]>(
      TRENDING_COMMUNITIES_SQL,
      [viewerId ?? null, query.limit ?? 10],
    );
    return { items: rows.map(toDiscovered) };
  }

  async recommended(
    query: DiscoveryQueryDto,
    userId: string,
  ): Promise<DiscoveredCommunityListDto> {
    const limit = query.limit ?? 10;
    const [rows] = await this.pool.execute<DiscoveredRow[]>(
      RECOMMENDED_COMMUNITIES_SQL,
      [userId, this.peers, userId, userId, limit],
    );
    const items = rows.map(toDiscovered);
    if (items.length < limit) {
      const [popular] = await this.pool.execute<DiscoveredRow[]>(
        POPULAR_COMMUNITIES_SQL,
        [userId, userId, limit],
      );
      const seen = new Set(items.map((item) => item.id));
      for (const row of popular) {
        if (items.length >= limit) break;
        if (!seen.has(row.id)) items.push(toDiscovered(row));
      }
    }
    return { items };
  }

  // Idempotent. A muted community disappears from the caller's feed, search
  // and discovery; its own page, posts and the caller's membership stay.
  async mute(name: string, userId: string): Promise<void> {
    const community = await readCommunityRole(this.pool, name, userId);
    await this.pool.execute<ResultSetHeader>(MUTE_COMMUNITY_SQL, [
      userId,
      community.id,
    ]);
  }

  async unmute(name: string, userId: string): Promise<void> {
    const community = await readCommunityRole(this.pool, name, userId);
    await this.pool.execute<ResultSetHeader>(UNMUTE_COMMUNITY_SQL, [
      userId,
      community.id,
    ]);
  }
}
