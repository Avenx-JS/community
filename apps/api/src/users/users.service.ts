import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';

interface UserProfileRow extends RowDataPacket {
  username: string;
}

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
}
