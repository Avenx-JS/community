import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';

interface UserProfileRow extends RowDataPacket {
  username: string;
}

interface UserPlatformRoleRow extends RowDataPacket {
  role: PlatformRole;
}

export type PlatformRole = 'user' | 'moderator' | 'admin';

export interface UserProfile {
  username: string;
}

@Injectable()
export class UsersService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async getUserProfile(username: string): Promise<UserProfile> {
    const [users] = await this.pool.execute<UserProfileRow[]>(
      'SELECT username FROM users WHERE username = ? LIMIT 1',
      [username],
    );
    const user = users[0];

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return { username: user.username };
  }

  async getPlatformRole(userId: string): Promise<PlatformRole | null> {
    const [users] = await this.pool.execute<UserPlatformRoleRow[]>(
      'SELECT role FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    return users[0]?.role ?? null;
  }
}
