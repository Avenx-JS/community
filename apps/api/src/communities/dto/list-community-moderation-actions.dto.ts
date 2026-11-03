import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  COMMUNITY_MODERATION_ACTIONS,
  COMMUNITY_MODERATION_TARGETS,
} from '../community-moderation-log.service';
import type {
  CommunityModerationAction,
  CommunityModerationTarget,
} from '../community-moderation-log.service';

export class ListCommunityModerationActionsDto {
  @IsOptional()
  @IsIn(COMMUNITY_MODERATION_ACTIONS)
  action?: CommunityModerationAction;

  /** Exact match on the stored username snapshot. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/)
  actor_username?: string;

  @IsOptional()
  @IsIn(COMMUNITY_MODERATION_TARGETS)
  target_type?: CommunityModerationTarget;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;

  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['new', 'oldest'])
  sort: 'new' | 'oldest' = 'new';
}
