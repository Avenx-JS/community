import { ApiProperty } from '@nestjs/swagger';
import {
  AdminCommunityDetailResponse,
  AdminRestrictionResponse,
} from '../admin/admin.responses';
import {
  AdminCommentDetailResponse,
  AdminPostDetailResponse,
} from '../admin/admin-content.responses';
import type {
  AdminAppealDetail,
  AdminAppealList,
  AdminAppealListItem,
  AdminAppealOriginalDecision,
  AdminAppealTarget,
  AdminAppealUser,
  AdminPriorAppeal,
} from './admin-appeals.service';
import type { AppealDto, AppealListDto } from './appeals.service';
import {
  APPEAL_STATUSES,
  APPEAL_TARGET_TYPES,
  type AppealStatus,
  type AppealTargetType,
} from './dto/appeals.dto';

export class AppealResponse implements AppealDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: APPEAL_TARGET_TYPES })
  target_type!: AppealTargetType;

  @ApiProperty({ description: 'The restriction, post, comment or community.' })
  target_id!: string;

  @ApiProperty({ description: 'Your reason, as you wrote it.' })
  reason!: string;

  @ApiProperty({ enum: APPEAL_STATUSES })
  status!: AppealStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The administrators' answer; null while open.",
  })
  decision_note!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decided_at!: string | null;
}

export class AppealListResponse implements AppealListDto {
  @ApiProperty({ type: [AppealResponse] })
  items!: AppealResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class AdminAppealUserResponse implements AdminAppealUser {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once the account is deleted.',
  })
  username!: string | null;
}

export class AdminAppealOriginalDecisionResponse implements AdminAppealOriginalDecision {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The restriction reason, removal reason or suspension reason, as it ' +
      'was when the appeal was filed.',
  })
  reason!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Null once the administrator's account is gone.",
  })
  actor_id!: string | null;

  @ApiProperty({ type: String, nullable: true })
  actor_username!: string | null;

  @ApiProperty({ format: 'date-time' })
  decided_at!: string;
}

export class AdminAppealTargetResponse implements AdminAppealTarget {
  @ApiProperty({ enum: ['suspension', 'ban'], nullable: true })
  restriction_type!: 'suspension' | 'ban' | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  restriction_expires_at!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The removed post, or the removed comment's post.",
  })
  post_id!: string | null;

  @ApiProperty({ type: String, nullable: true })
  post_title!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The first 200 characters of a removed comment.',
  })
  excerpt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  community_id!: string | null;

  @ApiProperty({ type: String, nullable: true })
  community_name!: string | null;

  @ApiProperty({
    description:
      'The appealed decision still stands: not reversed, not expired, and ' +
      'not replaced by a later decision on the same target.',
  })
  in_force!: boolean;
}

export class AdminAppealListItemResponse implements AdminAppealListItem {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: APPEAL_STATUSES })
  status!: AppealStatus;

  @ApiProperty({ enum: APPEAL_TARGET_TYPES })
  target_type!: AppealTargetType;

  @ApiProperty()
  target_id!: string;

  @ApiProperty({ description: "The user's reason." })
  reason!: string;

  @ApiProperty({ type: String, nullable: true })
  decision_note!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decided_at!: string | null;

  @ApiProperty({ type: String, nullable: true })
  decided_by_username!: string | null;

  @ApiProperty({ type: AdminAppealUserResponse })
  user!: AdminAppealUserResponse;

  @ApiProperty({ type: AdminAppealOriginalDecisionResponse })
  original_decision!: AdminAppealOriginalDecisionResponse;

  @ApiProperty({ type: AdminAppealTargetResponse })
  target!: AdminAppealTargetResponse;
}

export class AdminAppealFiltersResponse {
  @ApiProperty({ enum: [...APPEAL_STATUSES, 'any'] })
  status!: AppealStatus | 'any';

  @ApiProperty({ enum: APPEAL_TARGET_TYPES, nullable: true })
  target_type!: AppealTargetType | null;
}

export class AdminAppealListResponse implements AdminAppealList {
  @ApiProperty({ type: [AdminAppealListItemResponse] })
  items!: AdminAppealListItemResponse[];

  @ApiProperty({ type: 'integer' })
  page!: number;

  @ApiProperty({ type: 'integer' })
  limit!: number;

  @ApiProperty({ type: 'integer' })
  total!: number;

  @ApiProperty({ type: AdminAppealFiltersResponse })
  filters!: AdminAppealFiltersResponse;
}

export class AdminPriorAppealResponse implements AdminPriorAppeal {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: APPEAL_TARGET_TYPES })
  target_type!: AppealTargetType;

  @ApiProperty()
  target_id!: string;

  @ApiProperty({ enum: APPEAL_STATUSES })
  status!: AppealStatus;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decided_at!: string | null;
}

export class AdminAppealDetailResponse
  extends AdminAppealListItemResponse
  implements AdminAppealDetail
{
  @ApiProperty({
    type: AdminRestrictionResponse,
    nullable: true,
    description: 'For target_type restriction.',
  })
  restriction!: AdminRestrictionResponse | null;

  @ApiProperty({
    type: AdminPostDetailResponse,
    nullable: true,
    description: 'For target_type post_removal; null if the post is gone.',
  })
  post!: AdminPostDetailResponse | null;

  @ApiProperty({
    type: AdminCommentDetailResponse,
    nullable: true,
    description:
      'For target_type comment_removal; null if the comment is gone.',
  })
  comment!: AdminCommentDetailResponse | null;

  @ApiProperty({
    type: AdminCommunityDetailResponse,
    nullable: true,
    description:
      'For target_type community_suspension; null if the community is gone.',
  })
  community!: AdminCommunityDetailResponse | null;

  @ApiProperty({
    type: [AdminPriorAppealResponse],
    description: "The user's other appeals, newest first, at most 20.",
  })
  prior_appeals!: AdminPriorAppealResponse[];

  @ApiProperty({
    type: 'integer',
    description: "All the user's other appeals.",
  })
  prior_appeal_count!: number;
}
