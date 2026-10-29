import { ApiProperty } from '@nestjs/swagger';
import type {
  CommunityDto,
  CommunityListDto,
  SubscriptionDto,
  SubscriptionListDto,
  SubscriptionStatusDto,
} from './communities.service';
import type { CommunityRuleItem } from './community-rules-hash';
import type {
  CommunityRulesDto,
  CommunityRuleVersionDto,
  CommunityRuleVersionListDto,
  RuleAcceptanceDto,
} from './community-rules.service';
import type { NotificationPreferencesDto } from './notification-preferences.service';

export class CommunityResponse implements CommunityDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  creator_id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

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

export class NotificationPreferencesResponse implements NotificationPreferencesDto {
  @ApiProperty({
    description:
      'Effective setting; true unless muted. Delivers only while subscribed.',
  })
  new_posts!: boolean;

  @ApiProperty({
    description: 'Membership, which defines whether anything is delivered.',
  })
  subscribed!: boolean;
}

export class SubscriptionStatusResponse implements SubscriptionStatusDto {
  @ApiProperty()
  subscribed!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  subscribed_at!: string | null;
}

export class CommunityRuleItemResponse implements CommunityRuleItem {
  @ApiProperty({
    type: 'integer',
    description: 'One-based; the item index in the published request.',
  })
  position!: number;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  body!: string | null;
}

export class CommunityRulesResponse implements CommunityRulesDto {
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Null when the community has never published rules.',
  })
  version!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  published_at!: string | null;

  @ApiProperty({ type: [CommunityRuleItemResponse] })
  items!: CommunityRuleItemResponse[];
}

export class CommunityRuleVersionResponse implements CommunityRuleVersionDto {
  @ApiProperty({ type: 'integer' })
  version!: number;

  @ApiProperty({ format: 'date-time' })
  published_at!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null when the publishing account has been deleted.',
  })
  published_by_username!: string | null;

  @ApiProperty({ type: 'integer' })
  rule_count!: number;
}

export class CommunityRuleVersionListResponse implements CommunityRuleVersionListDto {
  @ApiProperty({ type: [CommunityRuleVersionResponse] })
  items!: CommunityRuleVersionResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class CommunityRuleAcceptanceResponse implements RuleAcceptanceDto {
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Null when the community has no published rules.',
  })
  current_version!: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Highest version you have accepted, which may be older.',
  })
  accepted_version!: number | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When you accepted accepted_version.',
  })
  accepted_at!: string | null;

  @ApiProperty({
    description: 'True until you accept the current version.',
  })
  acceptance_required!: boolean;
}
