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
} from '../../reports/report.constants';
import type {
  ReportReason,
  ReportStatus,
} from '../../reports/report.constants';

export class ListReportsDto {
  @IsOptional()
  @IsIn(REPORT_STATUSES)
  status?: ReportStatus;

  @IsOptional()
  @IsIn(REPORT_REASONS)
  reason?: ReportReason;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/)
  reported_username?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_]{3,50}$/)
  reporter_username?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsIn(['new', 'oldest'])
  sort: 'new' | 'oldest' = 'new';
}
