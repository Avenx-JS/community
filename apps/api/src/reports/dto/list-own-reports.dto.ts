import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { REPORT_STATUSES, REPORT_TARGET_TYPES } from '../report.constants';
import type { ReportStatus, ReportTargetType } from '../report.constants';

// Query of GET /reports. There is no reporter parameter: the list is always the
// caller's own.
export class ListOwnReportsDto {
  @IsOptional()
  @IsIn(REPORT_STATUSES)
  status?: ReportStatus;

  @IsOptional()
  @IsIn(REPORT_TARGET_TYPES)
  target_type?: ReportTargetType;

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
  page = 1;

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
  limit = 20;

  @ApiPropertyOptional({ enum: ['new', 'oldest'], default: 'new' })
  @IsOptional()
  @IsIn(['new', 'oldest'])
  sort: 'new' | 'oldest' = 'new';
}
