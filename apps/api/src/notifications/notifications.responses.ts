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

export class ReadAllNotificationsResponse {
  @ApiProperty({
    type: 'integer',
    description: 'How many unread notifications were marked read.',
  })
  updated!: number;
}

export class DeleteAllNotificationsResponse {
  @ApiProperty({
    type: 'integer',
    description: 'How many notifications were deleted; 0 for an empty inbox.',
  })
  deleted!: number;
}

export class StreamTicketResponse {
  @ApiProperty({
    description:
      'Single use: GET /notifications/stream?ticket=<ticket>. Bound to the ' +
      'session it was minted with.',
  })
  ticket!: string;

  @ApiProperty({ type: 'integer', description: 'Seconds until it expires.' })
  expires_in!: number;
}

export class PushSubscriptionResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    description:
      "The push service's origin; the full endpoint is never returned.",
    example: 'https://fcm.googleapis.com',
  })
  endpoint_origin!: string;

  @ApiProperty({ type: String, nullable: true })
  user_agent!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  last_success_at!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expires_at!: string | null;
}

export class PushSubscriptionListResponse {
  @ApiProperty({
    description: 'false when the server has no VAPID keys configured.',
  })
  enabled!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The applicationServerKey for PushManager.subscribe(), base64url; ' +
      'null when disabled.',
  })
  public_key!: string | null;

  @ApiProperty({ type: [PushSubscriptionResponse] })
  items!: PushSubscriptionResponse[];
}
