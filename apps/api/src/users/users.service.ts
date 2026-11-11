import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import type { UpdateOwnProfileDto } from './dto/update-own-profile.dto';
import { loadMediaByIds, type MediaDto } from '../media/media-dto';

interface UserProfileRow extends RowDataPacket {
  username: string;
  display_name: string | null;
  bio: string | null;
  created_at: Date | string;
  avatar_media_id?: string | null;
}

interface OwnProfileRow extends UserProfileRow {
  id: string;
  email: string;
  role: PlatformRole;
}

interface UserPlatformRoleRow extends RowDataPacket {
  role: PlatformRole;
}

export type PlatformRole = 'user' | 'moderator' | 'admin';

export interface UserProfile {
  username: string;
  display_name: string | null;
  bio: string | null;
  created_at: string;
  // PUT /users/me/avatar; null without one.
  avatar: MediaDto | null;
}

// The caller's own account. The only response that carries email and role;
// last_seen_at is analytics telemetry, not a profile field.
export interface OwnProfile extends UserProfile {
  id: string;
  email: string;
  role: PlatformRole;
}

export const OWN_PROFILE_SQL =
  'SELECT id, username, email, display_name, bio, role, created_at, avatar_media_id FROM users WHERE id = ? LIMIT 1';
export const USER_PROFILE_SQL =
  'SELECT username, display_name, bio, created_at, avatar_media_id FROM users WHERE username = ? AND deleted_at IS NULL LIMIT 1';

@Injectable()
export class UsersService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async getUserProfile(username: string): Promise<UserProfile> {
    const [users] = await this.pool.execute<UserProfileRow[]>(
      USER_PROFILE_SQL,
      [username],
    );
    const user = users[0];

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      username: user.username,
      display_name: user.display_name,
      bio: user.bio,
      created_at: new Date(user.created_at).toISOString(),
      avatar: await this.avatarOf(user),
    };
  }

  // A second statement only for an account with an avatar.
  private async avatarOf(user: UserProfileRow): Promise<MediaDto | null> {
    const media = await loadMediaByIds(this.pool, [user.avatar_media_id]);
    return (user.avatar_media_id && media.get(user.avatar_media_id)) || null;
  }

  async getOwnProfile(userId: string): Promise<OwnProfile> {
    const [users] = await this.pool.execute<OwnProfileRow[]>(OWN_PROFILE_SQL, [
      userId,
    ]);
    const user = users[0];

    // Only reachable if the account was deleted after its token was checked.
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      display_name: user.display_name,
      bio: user.bio,
      role: user.role,
      created_at: new Date(user.created_at).toISOString(),
      avatar: await this.avatarOf(user),
    };
  }

  // userId comes from the verified token only; nothing in the body can
  // select the row. An absent field is left untouched; "" stores NULL.
  async updateOwnProfile(
    userId: string,
    changes: UpdateOwnProfileDto,
  ): Promise<OwnProfile> {
    const assignments: string[] = [];
    const values: (string | null)[] = [];
    for (const field of ['display_name', 'bio'] as const) {
      const value = changes[field];
      if (value !== undefined) {
        assignments.push(`${field} = ?`);
        values.push(value === '' ? null : value);
      }
    }

    if (assignments.length > 0) {
      await this.pool.execute(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = ?`,
        [...values, userId],
      );
    }
    return this.getOwnProfile(userId);
  }

  async getPlatformRole(userId: string): Promise<PlatformRole | null> {
    const [users] = await this.pool.execute<UserPlatformRoleRow[]>(
      'SELECT role FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    return users[0]?.role ?? null;
  }
}
