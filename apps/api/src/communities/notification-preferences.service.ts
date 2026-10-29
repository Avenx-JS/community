import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

interface PreferenceRow extends RowDataPacket {
  id: string;
  subscribed: number;
  new_posts: number | null;
}

export interface NotificationPreferencesDto {
  new_posts: boolean;
  subscribed: boolean;
}

@Injectable()
export class NotificationPreferencesService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // new_posts is the effective value: a missing row means the default, true.
  async get(name: string, userId: string): Promise<NotificationPreferencesDto> {
    const [rows] = await this.pool.execute<PreferenceRow[]>(
      `SELECT c.id,
         EXISTS (
           SELECT 1 FROM community_subscriptions s
           WHERE s.community_id = c.id AND s.user_id = ?
         ) AS subscribed,
         p.new_posts
       FROM communities c
       LEFT JOIN community_notification_preferences p
         ON p.community_id = c.id AND p.user_id = ?
       WHERE c.name = ? LIMIT 1`,
      [userId, userId, name],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Community not found');
    }

    return {
      new_posts: row.new_posts === null ? true : Boolean(row.new_posts),
      subscribed: Boolean(row.subscribed),
    };
  }

  // Membership is not required: the row is inert without it, and keeping it
  // preserves a mute across leaving and rejoining.
  async update(
    name: string,
    userId: string,
    input: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    const [communities] = await this.pool.execute<
      (RowDataPacket & { id: string })[]
    >('SELECT id FROM communities WHERE name = ? LIMIT 1', [name]);
    const community = communities[0];
    if (!community) {
      throw new NotFoundException('Community not found');
    }

    await this.pool.execute<ResultSetHeader>(
      'INSERT INTO community_notification_preferences (user_id, community_id, new_posts) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE new_posts = VALUES(new_posts)',
      [userId, community.id, input.new_posts],
    );

    return this.get(name, userId);
  }
}
