import { ApiProperty } from '@nestjs/swagger';
import type {
  AssignedFlairDto,
  FlairDto,
  FlairListDto,
  UserFlairDto,
} from './community-flairs.service';
import { FLAIR_KINDS, type FlairKind } from './dto/community-flairs.dto';
import type {
  JoinRequestDto,
  JoinRequestStatus,
  PendingJoinRequestDto,
  PendingJoinRequestListDto,
} from './community-join-requests.service';
import type {
  ModeratorInviteDto,
  ModeratorInviteListDto,
} from './community-moderator-invites.service';
import type {
  DiscoveredCommunityDto,
  DiscoveredCommunityListDto,
} from './community-discovery.service';
import { CommunityResponse } from './communities.responses';

export class AssignedFlairResponse implements AssignedFlairDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  text!: string;

  @ApiProperty({ type: String, nullable: true, example: '#ff4500' })
  background_color!: string | null;
}

export class UserFlairResponse implements UserFlairDto {
  @ApiProperty({ type: AssignedFlairResponse, nullable: true })
  flair!: AssignedFlairResponse | null;
}

export class FlairResponse implements FlairDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: FLAIR_KINDS })
  kind!: FlairKind;

  @ApiProperty()
  text!: string;

  @ApiProperty({ type: String, nullable: true, example: '#ff4500' })
  background_color!: string | null;

  @ApiProperty({ description: 'Only moderators may assign it.' })
  mod_only!: boolean;
}

export class FlairListResponse implements FlairListDto {
  @ApiProperty({ type: [FlairResponse] })
  items!: FlairResponse[];
}

const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'denied'] as const;

export class JoinRequestResponse implements JoinRequestDto {
  @ApiProperty({ description: 'The community name.' })
  community!: string;

  @ApiProperty({ enum: JOIN_REQUEST_STATUSES })
  status!: JoinRequestStatus;

  @ApiProperty({ type: String, nullable: true })
  message!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decided_at!: string | null;
}

export class PendingJoinRequestResponse implements PendingJoinRequestDto {
  @ApiProperty()
  username!: string;

  @ApiProperty({ type: String, nullable: true })
  display_name!: string | null;

  @ApiProperty({ type: String, nullable: true })
  message!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class PendingJoinRequestListResponse implements PendingJoinRequestListDto {
  @ApiProperty({ type: [PendingJoinRequestResponse] })
  items!: PendingJoinRequestResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

class InvitingCommunityResponse {
  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;
}

export class ModeratorInviteResponse implements ModeratorInviteDto {
  @ApiProperty({ type: InvitingCommunityResponse })
  community!: InvitingCommunityResponse;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The inviter's username; null once that account is deleted.",
  })
  invited_by!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class ModeratorInviteListResponse implements ModeratorInviteListDto {
  @ApiProperty({ type: [ModeratorInviteResponse] })
  items!: ModeratorInviteResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class DiscoveredCommunityResponse
  extends CommunityResponse
  implements DiscoveredCommunityDto
{
  @ApiProperty({
    type: 'integer',
    description:
      'Trending: posts in the last 24 hours. Recommended: members shared ' +
      'with your communities (0 for the popularity fallback).',
  })
  activity!: number;

  @ApiProperty({
    type: 'integer',
    description: 'Members gained in the last 7 days.',
  })
  new_members!: number;
}

export class DiscoveredCommunityListResponse implements DiscoveredCommunityListDto {
  @ApiProperty({ type: [DiscoveredCommunityResponse] })
  items!: DiscoveredCommunityResponse[];
}
