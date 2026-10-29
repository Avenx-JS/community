import { IsBoolean } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  /** Whether new posts in this community notify you while you are a member. */
  @IsBoolean()
  new_posts!: boolean;
}
