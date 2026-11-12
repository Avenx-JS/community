import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { isSqlTrue } from '../common/community-moderation';
import {
  DEFAULT_USER_PREFERENCES,
  type UpdateUserPreferencesDto,
  type UserPreferences,
} from './dto/user-preferences.dto';

export const USER_PREFERENCES_SQL =
  'SELECT email_notifications, new_community_notifications, show_nsfw, timezone, language FROM user_preferences WHERE user_id = ? LIMIT 1';
export const UPSERT_USER_PREFERENCES_SQL =
  'INSERT INTO user_preferences (user_id, email_notifications, new_community_notifications, show_nsfw, timezone, language) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE email_notifications = VALUES(email_notifications), new_community_notifications = VALUES(new_community_notifications), show_nsfw = VALUES(show_nsfw), timezone = VALUES(timezone), language = VALUES(language)';

// Applied when an account subscribes to a community (CommunitiesService):
// with new_community_notifications off, the new membership starts with
// new_posts off. Never overrides a setting the account already made for that
// community. Bound to [user, community, user].
export const APPLY_DEFAULT_COMMUNITY_NOTIFICATIONS_SQL = `INSERT INTO community_notification_preferences (user_id, community_id, new_posts)
       SELECT ?, ?, FALSE FROM user_preferences
       WHERE user_preferences.user_id = ? AND user_preferences.new_community_notifications = FALSE
       ON DUPLICATE KEY UPDATE new_posts = community_notification_preferences.new_posts`;

interface PreferencesRow extends RowDataPacket {
  email_notifications: number | boolean;
  new_community_notifications: number | boolean;
  show_nsfw: number | boolean;
  timezone: string;
  language: string;
}

@Injectable()
export class UserPreferencesService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // An account without a row has the defaults; GET never writes one.
  async get(userId: string): Promise<UserPreferences> {
    const [rows] = await this.pool.execute<PreferencesRow[]>(
      USER_PREFERENCES_SQL,
      [userId],
    );
    const row = rows[0];
    if (!row) {
      return { ...DEFAULT_USER_PREFERENCES };
    }
    return {
      email_notifications: isSqlTrue(row.email_notifications),
      new_community_notifications: isSqlTrue(row.new_community_notifications),
      show_nsfw: isSqlTrue(row.show_nsfw),
      timezone: row.timezone,
      language: row.language,
    };
  }

  async replace(
    userId: string,
    input: UpdateUserPreferencesDto,
  ): Promise<UserPreferences> {
    await this.pool.execute(UPSERT_USER_PREFERENCES_SQL, [
      userId,
      input.email_notifications,
      input.new_community_notifications,
      input.show_nsfw,
      input.timezone,
      input.language,
    ]);
    return this.get(userId);
  }
}
