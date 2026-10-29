import { ApiProperty } from '@nestjs/swagger';
import type { UserProfile } from './users.service';

export class UserProfileResponse implements UserProfile {
  @ApiProperty()
  username!: string;
}
