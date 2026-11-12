import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { COMMUNITY_REPORT_STATUSES } from '../community-report-review';

export const MODQUEUE_SORTS = ['oldest', 'newest', 'most_reported'] as const;
export type ModQueueSort = (typeof MODQUEUE_SORTS)[number];

export const COMMUNITY_REPORT_TARGET_TYPES = ['post', 'comment'] as const;

export const COMMUNITY_REPORT_FILTERS = [
  ...COMMUNITY_REPORT_STATUSES,
  'any',
] as const;
export type CommunityReportFilter = (typeof COMMUNITY_REPORT_FILTERS)[number];

class PageDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    enum: COMMUNITY_REPORT_TARGET_TYPES,
    description: 'Only reports about posts, or only about comments.',
  })
  @IsOptional()
  @IsIn(COMMUNITY_REPORT_TARGET_TYPES)
  target_type?: 'post' | 'comment';
}

// GET /communities/:name/modqueue.
export class ListModQueueDto extends PageDto {
  @ApiPropertyOptional({
    enum: MODQUEUE_SORTS,
    default: 'oldest',
    description:
      'oldest (default): the content waiting longest, by its first open ' +
      'report. newest: by its latest open report. most_reported: the most ' +
      'open reports first, then the longest waiting.',
  })
  @IsOptional()
  @IsIn(MODQUEUE_SORTS)
  sort?: ModQueueSort;
}

// GET /communities/:name/reports.
export class ListCommunityReportsDto extends PageDto {
  @ApiPropertyOptional({
    enum: COMMUNITY_REPORT_FILTERS,
    default: 'open',
    description:
      "The moderators' review state: open (default), approved, removed, or any.",
  })
  @IsOptional()
  @IsIn(COMMUNITY_REPORT_FILTERS)
  status?: CommunityReportFilter;

  @ApiPropertyOptional({ enum: ['newest', 'oldest'], default: 'newest' })
  @IsOptional()
  @IsIn(['newest', 'oldest'])
  sort?: 'newest' | 'oldest';
}
