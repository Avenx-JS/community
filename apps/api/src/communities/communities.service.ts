import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { escapeLikeSearch } from '../common/like-search';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';
import { CreateCommunityDto } from './dto/create-community.dto';
import { ListCommunitiesDto } from './dto/list-communities.dto';
import { ListSubscriptionsDto } from './dto/list-subscriptions.dto';

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

@Injectable()
export class CommunitiesService {
  constructor(
    @Inject(MYSQL_POOL) private readonly pool: Pool,
    private readonly ruleAcceptance: CommunityRuleAcceptanceService,
  ) {}

  async findAll(query: ListCommunitiesDto): Promise<CommunityListDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;
    const search = query.search?.trim();
    let where = '';
    let values: (string | number)[] = [];

    if (search) {
      const term = `%${escapeLikeSearch(search)}%`;
      where =
        " WHERE LOWER(name) LIKE LOWER(?) ESCAPE '=' OR LOWER(description) LIKE LOWER(?) ESCAPE '='";
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

  async findOne(name: string): Promise<CommunityDto> {
    const [communities] = await this.pool.execute<CommunityRow[]>(
      'SELECT id, creator_id, name, description, created_at FROM communities WHERE name = ? LIMIT 1',
      [name],
    );
    const community = communities[0];

    if (!community) {
      throw new NotFoundException('Community not found');
    }

    return this.toDto(community);
  }

  // Joining is participation, so it requires the current rules to be
  // accepted. Leaving (unsubscribe) deliberately does not: a user who
  // declines the rules must not be trapped in the community.
  async subscribe(name: string, userId: string): Promise<void> {
    const communityId = await this.getCommunityId(name);
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
       WHERE s.user_id = ?
       ORDER BY s.created_at DESC, s.community_id DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset],
    );
    const [countRows] = await this.pool.execute<
      (RowDataPacket & { total: number })[]
    >(
      'SELECT COUNT(*) AS total FROM community_subscriptions WHERE user_id = ?',
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

  private async getCommunityForRoleChange(
    name: string,
    actorId: string,
  ): Promise<{ id: string; creator_id: string }> {
    const [communities] = await this.pool.execute<
      (RowDataPacket & { id: string; creator_id: string })[]
    >('SELECT id, creator_id FROM communities WHERE name = ? LIMIT 1', [name]);
    const community = communities[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    if (community.creator_id !== actorId) {
      throw new ForbiddenException(
        'Only the community creator can manage moderators',
      );
    }
    return community;
  }

  private async getCommunityId(name: string): Promise<string> {
    const [communities] = await this.pool.execute<
      (RowDataPacket & { id: string })[]
    >('SELECT id FROM communities WHERE name = ? LIMIT 1', [name]);
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
