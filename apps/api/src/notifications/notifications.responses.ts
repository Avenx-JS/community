import { ApiProperty } from '@nestjs/swagger';
import type {
  NotificationDto,
  NotificationListDto,
  UnreadCountDto,
} from './notification-inbox.service';
import {
  NOTIFICATION_SUBJECT_TYPES,
  NOTIFICATION_TYPES,
  type NotificationSubjectType,
  type NotificationType,
} from './notification-metadata';

export class NotificationResponse implements NotificationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: NOTIFICATION_TYPES })
  type!: NotificationType;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Snapshot taken when the notification was created. Always null for ' +
      'moderation outcomes.',
  })
  actor_username!: string | null;

  @ApiProperty({ enum: NOTIFICATION_SUBJECT_TYPES })
  subject_type!: NotificationSubjectType;

  @ApiProperty({
    description: 'The triggering object; it may since have been deleted.',
  })
  subject_id!: string;

  @ApiProperty({ type: String, nullable: true })
  community_id!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Snapshot taken when the notification was created.',
  })
  community_name!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    nullable: true,
    description:
      'Per-type snapshot: post_id, parent_comment_id, post_title, excerpt, ' +
      'status, restriction_type, expires_at.',
  })
  metadata!: Record<string, string> | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  read_at!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class NotificationListResponse implements NotificationListDto {
  @ApiProperty({ type: [NotificationResponse] })
  items!: NotificationResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class UnreadCountResponse implements UnreadCountDto {
  @ApiProperty({ type: 'integer' })
  unread!: number;
}
