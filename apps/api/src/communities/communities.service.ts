import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
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
import { CommunityBanPolicyService } from './community-ban-policy.service';
import {
  canModerateCommunitySql,
  isSqlTrue,
} from '../common/community-moderation';
import { escapeLikeSearch } from '../common/like-search';
import {
  CommunityModerationLogService,
  EDITABLE_COMMUNITY_FIELDS,
} from './community-moderation-log.service';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';
import { loadMediaByIds, type MediaDto } from '../media/media-dto';
import { RELEASE_COMMUNITY_MEDIA_SQL } from '../media/media-sql';
import { CreateCommunityDto } from './dto/create-community.dto';
import { ListCommunitiesDto } from './dto/list-communities.dto';
import { ListCommunityMembersDto } from './dto/list-community-members.dto';
import { ListCommunityModeratorsDto } from './dto/list-community-moderators.dto';
import { ListSubscriptionsDto } from './dto/list-subscriptions.dto';
import { UpdateCommunityDto } from './dto/update-community.dto';
import {
  COMMUNITY_VISIBLE_PREDICATE,
  visibleCommunityColumnsSql,
} from '../common/community-visibility';

interface CreatorCheckOptions {
  executor?: Pool | PoolConnection;
  forUpdate?: boolean;
  forbidden?: string;
}

interface CommunityRow extends RowDataPacket {
  id: string;
  creator_id: string;
  name: string;
  description: string | null;
  created_at: Date | string;
}

export interface CommunityDto {
  id: string;
  creator_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

// GET /communities/:name: the community with its images
// (PUT /communities/:name/icon and /banner), each null when unset.
export interface CommunityDetailDto extends CommunityDto {
  icon: MediaDto | null;
  banner: MediaDto | null;
}

export interface CommunityListDto {
  items: CommunityDto[];
  page: number;
  limit: number;
  total: number;
}

interface SubscriptionRow extends RowDataPacket {
  id: string;
  name: string;
  description: string | null;
  subscribed_at: Date | string;
}

export interface SubscriptionDto {
  community: { id: string; name: string; description: string | null };
  subscribed_at: string;
}

export interface SubscriptionListDto {
  items: SubscriptionDto[];
  page: number;
  limit: number;
  total: number;
}

export interface SubscriptionStatusDto {
  subscribed: boolean;
  subscribed_at: string | null;
}

// Who counts as a moderator or member. Shared by the moderator and member
// lists and by CommunityStatsService, so the stats counts always equal the
// lists' totals. Moderators: bind (community_id, creator_id); the creator is
// reported separately, never as an appointed moderator. Members: bind
// (community_id); subscription rows, so the creator counts only if
// subscribed. Deleted accounts are excluded from both.
export const MODERATORS_FROM = `FROM community_moderators m
       JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? AND m.user_id <> ? AND u.deleted_at IS NULL`;
export const MEMBERS_JOIN = `FROM community_subscriptions s
       JOIN users u ON u.id = s.user_id`;
export const MEMBERS_WHERE = 's.community_id = ? AND u.deleted_at IS NULL';

// Public people lists expose usernames and display names only: never ids,
// email addresses, last_seen_at or users.role. The SELECT lists below are the
// boundary; the mappers copy named fields so a wider SELECT cannot leak.
interface PersonRow extends RowDataPacket {
  username: string;
  display_name: string | null;
}

interface CreatorRow extends PersonRow {
  id: string;
  created_at: Date | string;
  creator_id: string;
  creator_deleted_at: Date | string | null;
}

interface ModeratorRow extends PersonRow {
  since: Date | string;
}

interface MemberRow extends PersonRow {
  subscribed_at: Date | string;
  is_moderator: number | string | boolean;
}

export interface CommunityModeratorDto {
  username: string;
  display_name: string | null;
  role: 'moderator';
  since: string;
}

export interface CommunityCreatorDto {
  username: string;
  display_name: string | null;
  role: 'creator';
  since: string;
}

export interface CommunityModeratorListDto {
  creator: CommunityCreatorDto | null;
  items: CommunityModeratorDto[];
  page: number;
  limit: number;
  total: number;
}

export interface CommunityMemberDto {
  username: string;
  display_name: string | null;
  subscribed_at: string;
  is_moderator: boolean;
}

export interface CommunityMemberListDto {
  items: CommunityMemberDto[];
  page: number;
  limit: number;
  total: number;
}

// Both community predicates: soft deletion (022) and suspension (025).
export const LISTED_COMMUNITY_ID_SQL = `SELECT id FROM communities WHERE name = ? AND ${COMMUNITY_VISIBLE_PREDICATE} LIMIT 1`;

@Injectable()
export class CommunitiesService {
  private readonly bans: CommunityBanPolicyService;

  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly ruleAcceptance: CommunityRuleAcceptanceService,
    private readonly moderationLog: CommunityModerationLogService,
    @Optional() bans?: CommunityBanPolicyService,
  ) {
    this.bans = bans ?? new CommunityBanPolicyService(pool);
  }

  async findAll(query: ListCommunitiesDto): Promise<CommunityListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const search = query.search?.trim();
    let where = ` WHERE ${COMMUNITY_VISIBLE_PREDICATE}`;
    let values: (string | number)[] = [];

    if (search) {
      const term = `%${escapeLikeSearch(search)}%`;
      where +=
        " AND (LOWER(name) LIKE LOWER(?) ESCAPE '=' OR LOWER(description) LIKE LOWER(?) ESCAPE '=')";
      values = [term, term];
    }

    const [communities] = await this.pool.execute<CommunityRow[]>(
      `SELECT id, creator_id, name, description, created_at FROM communities${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number })[]
    >(`SELECT COUNT(*) AS total FROM communities${where}`, values);

    return {
      items: communities.map((community) => this.toDto(community)),
      page,
      limit,
      total: countRows[0].total,
    };
  }

  async create(
    input: CreateCommunityDto,
    creatorId: string,
  ): Promise<CommunityDto> {
    const id = randomUUID();

    try {
      await this.pool.execute<ResultSetHeader>(
        'INSERT INTO communities (id, creator_id, name, description) VALUES (?, ?, ?, ?)',
        [id, creatorId, input.name.trim(), input.description ?? null],
      );
    } catch (error) {
      if (this.isDuplicateEntry(error)) {
        throw new ConflictException('Community name already exists');
      }
      throw error;
    }

    const [communities] = await this.pool.execute<CommunityRow[]>(
      'SELECT id, creator_id, name, description, created_at FROM communities WHERE id = ? LIMIT 1',
      [id],
    );
    const community = communities[0];

    if (!community) {
      throw new Error('Created community could not be retrieved');
    }

    return this.toDto(community);
  }

  // The id behind a public community name, for routes that address a
  // community by name and then delegate to an id-keyed service (GET
  // /communities/:name/posts). A deleted or suspended community is a 404,
  // never an empty listing that would imply it exists and is merely quiet.
  async resolveListedId(name: string): Promise<string> {
    const [communities] = await this.pool.execute<
      (RowDataPacket & { id: string })[]
    >(LISTED_COMMUNITY_ID_SQL, [name]);
    const community = communities[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community.id;
  }

  async findOne(name: string): Promise<CommunityDetailDto> {
    const [communities] = await this.pool.execute<
      (CommunityRow & {
        icon_media_id?: string | null;
        banner_media_id?: string | null;
      })[]
    >(
      `SELECT id, creator_id, name, description, created_at, icon_media_id, banner_media_id FROM communities WHERE name = ? AND ${COMMUNITY_VISIBLE_PREDICATE} LIMIT 1`,
      [name],
    );
    const community = communities[0];

    if (!community) {
      throw new NotFoundException('Community not found');
    }

    // A second statement only for a community with an image.
    const media = await loadMediaByIds(this.pool, [
      community.icon_media_id,
      community.banner_media_id,
    ]);
    const image = (id: string | null | undefined) =>
      (id && media.get(id)) || null;
    return {
      ...this.toDto(community),
      icon: image(community.icon_media_id),
      banner: image(community.banner_media_id),
    };
  }

  // Joining is participation, so it requires the current rules to be
  // accepted. Leaving (unsubscribe) deliberately does not: a user who
  // declines the rules must not be trapped in the community.
  async subscribe(name: string, userId: string): Promise<void> {
    const communityId = await this.getCommunityId(name);
    // Without this a ban is defeated at once: banning deletes the membership,
    // and nothing else stops an immediate rejoin. Before the rule gate, so a
    // banned user is told the actionable fact.
    await this.bans.assertNotBannedOrThrow(userId, communityId);
    await this.ruleAcceptance.assertAcceptedOrThrow(userId, communityId);
    await this.pool.execute<ResultSetHeader>(
      'INSERT INTO community_subscriptions (user_id, community_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE created_at = created_at',
      [userId, communityId],
    );
  }

  async listSubscriptions(
    userId: string,
    query: ListSubscriptionsDto,
  ): Promise<SubscriptionListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const [subscriptions] = await this.pool.execute<SubscriptionRow[]>(
      `SELECT c.id, c.name, c.description, s.created_at AS subscribed_at
       FROM community_subscriptions s
       JOIN communities c ON c.id = s.community_id
       WHERE s.user_id = ? AND ${visibleCommunityColumnsSql('c')}
       ORDER BY s.created_at DESC, s.community_id DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number })[]
    >(
      `SELECT COUNT(*) AS total
       FROM community_subscriptions s
       JOIN communities c ON c.id = s.community_id
       WHERE s.user_id = ? AND ${visibleCommunityColumnsSql('c')}`,
      [userId],
    );

    return {
      items: subscriptions.map((subscription) => ({
        community: {
          id: subscription.id,
          name: subscription.name,
          description: subscription.description,
        },
        subscribed_at: new Date(subscription.subscribed_at).toISOString(),
      })),
      page,
      limit,
      total: countRows[0].total,
    };
  }

  async getSubscription(
    name: string,
    userId: string,
  ): Promise<SubscriptionStatusDto> {
    const communityId = await this.getCommunityId(name);
    const [subscriptions] = await this.pool.execute<
      (RowDataPacket & { created_at: Date | string })[]
    >(
      'SELECT created_at FROM community_subscriptions WHERE user_id = ? AND community_id = ? LIMIT 1',
      [userId, communityId],
    );
    const subscription = subscriptions[0];

    return subscription
      ? {
          subscribed: true,
          subscribed_at: new Date(subscription.created_at).toISOString(),
        }
      : { subscribed: false, subscribed_at: null };
  }

  async unsubscribe(name: string, userId: string): Promise<void> {
    const communityId = await this.getCommunityId(name);
    await this.pool.execute<ResultSetHeader>(
      'DELETE FROM community_subscriptions WHERE user_id = ? AND community_id = ?',
      [userId, communityId],
    );
  }

  async addModerator(
    name: string,
    username: string,
    actorId: string,
  ): Promise<void> {
    const community = await this.getCommunityForRoleChange(name, actorId);
    const [users] = await this.pool.execute<(RowDataPacket & { id: string })[]>(
      'SELECT id FROM users WHERE username = ? LIMIT 1',
      [username],
    );
    const user = users[0];
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.id !== community.creator_id) {
      const [memberships] = await this.pool.execute<
        (RowDataPacket & { user_id: string })[]
      >(
        'SELECT user_id FROM community_subscriptions WHERE community_id = ? AND user_id = ? LIMIT 1',
        [community.id, user.id],
      );
      if (!memberships[0]) {
        throw new ForbiddenException(
          'Only a subscribed community member can be appointed moderator',
        );
      }
    }

    await this.pool.execute<ResultSetHeader>(
      'INSERT INTO community_moderators (community_id, user_id, assigned_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = user_id',
      [community.id, user.id, actorId],
    );
  }

  async removeModerator(
    name: string,
    username: string,
    actorId: string,
  ): Promise<void> {
    const community = await this.getCommunityForRoleChange(name, actorId);
    await this.pool.execute<ResultSetHeader>(
      'DELETE FROM community_moderators WHERE community_id = ? AND user_id = (SELECT id FROM users WHERE username = ? LIMIT 1)',
      [community.id, username],
    );
  }

  // Public. The creator is a separate top-level object, not the first item:
  // it comes from another table, so putting it in the paginated list would
  // shift every page by one and need a UNION and a count correction. items
  // and total therefore cover appointed moderators only, and exclude the
  // creator even if also appointed. Deleted accounts are left out: they can
  // no longer act, and the moderation log keeps their username snapshot.
  async listModerators(
    name: string,
    query: ListCommunityModeratorsDto,
  ): Promise<CommunityModeratorListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const [communities] = await this.pool.execute<CreatorRow[]>(
      `SELECT c.id, c.created_at, c.creator_id,
         u.username, u.display_name, u.deleted_at AS creator_deleted_at
       FROM communities c
       JOIN users u ON u.id = c.creator_id
       WHERE c.name = ? AND ${visibleCommunityColumnsSql('c')} LIMIT 1`,
      [name],
    );
    const community = communities[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    const from = MODERATORS_FROM;
    const values = [community.id, community.creator_id];
    const [moderators] = await this.pool.execute<ModeratorRow[]>(
      `SELECT u.username, u.display_name, m.created_at AS since
       ${from}
       ORDER BY m.created_at ASC, m.user_id ASC LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total ${from}`, values);

    return {
      // An account cannot be deleted while it created a live community, so
      // this is null only for data written outside the API.
      creator:
        community.creator_deleted_at === null
          ? {
              username: community.username,
              display_name: community.display_name,
              role: 'creator',
              since: new Date(community.created_at).toISOString(),
            }
          : null,
      items: moderators.map((moderator) => ({
        username: moderator.username,
        display_name: moderator.display_name,
        role: 'moderator',
        since: new Date(moderator.since).toISOString(),
      })),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  // The creator and the community's moderators only: a roster is a bulk
  // extract of who belongs where, so it is a moderation tool, not a public
  // list. Platform administrators get no access here. Lists subscriptions,
  // so the creator appears only if subscribed.
  async listMembers(
    name: string,
    userId: string,
    query: ListCommunityMembersDto,
  ): Promise<CommunityMemberListDto> {
    const [communities] = await this.pool.execute<
      (RowDataPacket & {
        id: string;
        can_moderate: number | string | boolean;
      })[]
    >(
      `SELECT c.id, ${canModerateCommunitySql('c.id')} AS can_moderate
       FROM communities c
       WHERE c.name = ? AND ${visibleCommunityColumnsSql('c')} LIMIT 1`,
      [userId, userId, name],
    );
    const community = communities[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    if (!isSqlTrue(community.can_moderate)) {
      throw new ForbiddenException(
        'Only the community creator and moderators can list members',
      );
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    let where = MEMBERS_WHERE;
    const values: string[] = [community.id];
    const search = query.search?.trim();
    if (search) {
      where += " AND LOWER(u.username) LIKE LOWER(?) ESCAPE '='";
      values.push(`%${escapeLikeSearch(search)}%`);
    }
    // Served by idx_community_subscriptions_community_created (migration 024)
    // in index order; user_id is the tiebreaker.
    const order = query.sort === 'oldest' ? 'ASC' : 'DESC';

    const [members] = await this.pool.execute<MemberRow[]>(
      `SELECT u.username, u.display_name, s.created_at AS subscribed_at,
         m.user_id IS NOT NULL AS is_moderator
       ${MEMBERS_JOIN}
       LEFT JOIN community_moderators m
         ON m.community_id = s.community_id AND m.user_id = s.user_id
       WHERE ${where}
       ORDER BY s.created_at ${order}, s.user_id ${order} LIMIT ? OFFSET ?`,
      [...values, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number | string })[]
    >(`SELECT COUNT(*) AS total ${MEMBERS_JOIN} WHERE ${where}`, values);

    return {
      items: members.map((member) => ({
        username: member.username,
        display_name: member.display_name,
        subscribed_at: new Date(member.subscribed_at).toISOString(),
        is_moderator: isSqlTrue(member.is_moderator),
      })),
      page,
      limit,
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  // Creator only. Edits a community's public identity, so moderators are
  // refused: they hold no powers beyond content actions. Widening the edit to
  // moderators is a change to the creator check in getCommunityForRoleChange.
  async update(
    name: string,
    changes: UpdateCommunityDto,
    actorId: string,
  ): Promise<CommunityDto> {
    const assignments: string[] = [];
    const values: (string | null)[] = [];
    const fields: string[] = [];
    for (const field of EDITABLE_COMMUNITY_FIELDS) {
      const value = changes[field];
      if (value !== undefined) {
        assignments.push(`${field} = ?`);
        values.push(value === '' ? null : value);
        fields.push(field);
      }
    }
    if (assignments.length === 0) {
      throw new BadRequestException('description must be provided');
    }

    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;

      const community = await this.getCommunityForRoleChange(name, actorId, {
        executor: connection,
        forUpdate: true,
        forbidden: 'Only the community creator can edit the community',
      });
      await connection.execute<ResultSetHeader>(
        `UPDATE communities SET ${assignments.join(', ')} WHERE id = ?`,
        [...values, community.id],
      );
      await this.moderationLog.record(connection, {
        actorId,
        communityId: community.id,
        action: 'community_updated',
        targetType: 'community',
        targetId: community.id,
        metadata: { fields: fields.join(',') },
      });
      const [communities] = await connection.execute<CommunityRow[]>(
        'SELECT id, creator_id, name, description, created_at FROM communities WHERE id = ? LIMIT 1',
        [community.id],
      );
      const updated = communities[0];
      if (!updated) {
        throw new Error('Updated community could not be retrieved');
      }

      await connection.commit();
      return this.toDto(updated);
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  // Soft deletion: the row is marked and kept, and nothing that references it
  // is destroyed (a hard delete would cascade through every post and comment).
  // Every read excludes deleted_at IS NOT NULL. There is no restore route.
  async remove(
    name: string,
    confirmation: string,
    actorId: string,
  ): Promise<void> {
    if (confirmation !== name) {
      throw new BadRequestException(
        'The confirmation name does not match the community',
      );
    }

    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;

      // Locks the row, so a concurrent delete waits and then answers 404.
      const community = await this.getCommunityForRoleChange(name, actorId, {
        executor: connection,
        forUpdate: true,
        forbidden: 'Only the community creator can delete the community',
      });
      await connection.execute<ResultSetHeader>(
        'UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE id = ?',
        [actorId, community.id],
      );
      // Its icon and banner are released with it; its posts, and their
      // files, are kept like the posts themselves.
      for (const sql of RELEASE_COMMUNITY_MEDIA_SQL) {
        await connection.execute<ResultSetHeader>(sql, [community.id]);
      }
      await this.moderationLog.record(connection, {
        actorId,
        communityId: community.id,
        action: 'community_deleted',
        targetType: 'community',
        targetId: community.id,
      });

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

  // 404 for an unknown or deleted community, then 403 unless the actor is its
  // creator: the one place the creator-only rule lives.
  private async getCommunityForRoleChange(
    name: string,
    actorId: string,
    {
      executor = this.pool,
      forUpdate = false,
      forbidden = 'Only the community creator can manage moderators',
    }: CreatorCheckOptions = {},
  ): Promise<{ id: string; creator_id: string }> {
    const [communities] = await executor.execute<
      (RowDataPacket & { id: string; creator_id: string })[]
    >(
      `SELECT id, creator_id FROM communities WHERE name = ? AND ${COMMUNITY_VISIBLE_PREDICATE} LIMIT 1${
        forUpdate ? ' FOR UPDATE' : ''
      }`,
      [name],
    );
    const community = communities[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    if (community.creator_id !== actorId) {
      throw new ForbiddenException(forbidden);
    }
    return community;
  }

  private async getCommunityId(name: string): Promise<string> {
    const [communities] = await this.pool.execute<
      (RowDataPacket & { id: string })[]
    >(
      `SELECT id FROM communities WHERE name = ? AND ${COMMUNITY_VISIBLE_PREDICATE} LIMIT 1`,
      [name],
    );
    const community = communities[0];

    if (!community) {
      throw new NotFoundException('Community not found');
    }

    return community.id;
  }

  private toDto(community: CommunityRow): CommunityDto {
    return {
      id: community.id,
      creator_id: community.creator_id,
      name: community.name,
      description: community.description,
      created_at: new Date(community.created_at).toISOString(),
    };
  }

  private isDuplicateEntry(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ER_DUP_ENTRY'
    );
  }
}
