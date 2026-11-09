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
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
} from '../../reports/report.constants';
import type {
  ReportReason,
  ReportStatus,
  ReportTargetType,
} from '../../reports/report.constants';

export const REPORT_WITHDRAWN_FILTERS = ['exclude', 'include', 'only'] as const;
export type ReportWithdrawnFilter = (typeof REPORT_WITHDRAWN_FILTERS)[number];

export class ListReportsDto {
  @IsOptional()
  @IsIn(REPORT_STATUSES)
  status?: ReportStatus;

  @IsOptional()
  @IsIn(REPORT_REASONS)
  reason?: ReportReason;

  @IsOptional()
  @IsIn(REPORT_TARGET_TYPES)
  target_type?: ReportTargetType;

  /**
   * Matches user reports and reports of the account's posts and comments. Never
   * matches a community report, which concerns no account.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/)
  reported_username?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/)
  reporter_username?: string;

  @ApiPropertyOptional({
    enum: REPORT_WITHDRAWN_FILTERS,
    default: 'exclude',
    description:
      'Reports their reporter withdrew. `exclude` (default) hides them from ' +
      'the queue, `include` lists them alongside the rest, `only` lists ' +
      'nothing else.',
  })
  @IsOptional()
  @IsIn(REPORT_WITHDRAWN_FILTERS)
  withdrawn: ReportWithdrawnFilter = 'exclude';

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
