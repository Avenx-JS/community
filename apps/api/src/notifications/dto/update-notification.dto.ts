import { IsBoolean } from 'class-validator';

export class UpdateNotificationDto {
  /**
   * true marks the notification read (read_at from the database clock, kept
   * if already set); false marks it unread. read_at itself is never accepted.
   */
  @IsBoolean()
  read!: boolean;
}
