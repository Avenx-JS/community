import { ApiProperty } from '@nestjs/swagger';
import {
  MODMAIL_STATUSES,
  type ModmailMessageDto,
  type ModmailStatus,
  type ModmailThreadDetailDto,
  type ModmailThreadDto,
  type ModmailThreadListDto,
} from './modmail.service';

export class ModmailMessageResponse implements ModmailMessageDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty({ description: 'Written by the moderator team.' })
  is_moderator!: boolean;

  @ApiProperty({
    description:
      'The user\'s username, or "moderators of c/<name>" for a team message.',
  })
  author_label!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Who wrote it. For a team message, the moderator: shown to moderators ' +
      'only, always null for the user. Null once the account is deleted.',
  })
  author_username!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class ModmailThreadResponse implements ModmailThreadDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  community_name!: string;

  @ApiProperty()
  subject!: string;

  @ApiProperty({ enum: MODMAIL_STATUSES })
  status!: ModmailStatus;

  @ApiProperty({ enum: ['user', 'moderators'] })
  started_by!: 'user' | 'moderators';

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The user the team talks to; null once deleted.',
  })
  username!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ format: 'date-time' })
  last_message_at!: string;
}

export class ModmailThreadDetailResponse
  extends ModmailThreadResponse
  implements ModmailThreadDetailDto
{
  @ApiProperty({ type: [ModmailMessageResponse], description: 'Oldest first.' })
  messages!: ModmailMessageResponse[];
}

export class ModmailThreadListResponse implements ModmailThreadListDto {
  @ApiProperty({ type: [ModmailThreadResponse] })
  items!: ModmailThreadResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}
