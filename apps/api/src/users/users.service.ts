import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';

interface UserProfileRow extends RowDataPacket {
  id: string;
  username: string;
  created_at: Date | string;
}

export interface UserProfile {
  id: string;
  username: string;
  created_at: string;
}

@Injectable()
export class UsersService {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  async getUserProfile(username: string): Promise<UserProfile> {
    const [users] = await this.pool.execute<UserProfileRow[]>(
      'SELECT id, username, created_at FROM users WHERE username = ? LIMIT 1',
      [username],
    );
    const user = users[0];

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      id: user.id,
      username: user.username,
      created_at: new Date(user.created_at).toISOString(),
    };
  }
}
