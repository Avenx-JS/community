import { ApiProperty } from '@nestjs/swagger';
import type {
  CommunityDto,
  CommunityListDto,
  SubscriptionDto,
  SubscriptionListDto,
  SubscriptionStatusDto,
} from './communities.service';

export class CommunityResponse implements CommunityDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  creator_id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Legacy free-text rules, retained until versioned rules replace them.',
  })
  rules!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class CommunityListResponse implements CommunityListDto {
  @ApiProperty({ type: [CommunityResponse] })
  items!: CommunityResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class SubscribedCommunityResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;
}

export class SubscriptionResponse implements SubscriptionDto {
  @ApiProperty({ type: SubscribedCommunityResponse })
  community!: SubscribedCommunityResponse;

  @ApiProperty({ format: 'date-time' })
  subscribed_at!: string;
}

export class SubscriptionListResponse implements SubscriptionListDto {
  @ApiProperty({ type: [SubscriptionResponse] })
  items!: SubscriptionResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class SubscriptionStatusResponse implements SubscriptionStatusDto {
  @ApiProperty()
  subscribed!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  subscribed_at!: string | null;
}
