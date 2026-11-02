import { ApiProperty } from '@nestjs/swagger';
import type { OwnProfile, PlatformRole, UserProfile } from './users.service';

export class UserProfileResponse implements UserProfile {
  @ApiProperty()
  username!: string;

  @ApiProperty({ type: 'string', nullable: true, maxLength: 50 })
  display_name!: string | null;

  @ApiProperty({ type: 'string', nullable: true, maxLength: 500 })
  bio!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class OwnProfileResponse
  extends UserProfileResponse
  implements OwnProfile
{
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Returned by GET /users/me and nowhere else.' })
  email!: string;

  @ApiProperty({ enum: ['user', 'moderator', 'admin'] })
  role!: PlatformRole;
}
