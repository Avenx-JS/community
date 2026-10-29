import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import type { AnalyticsGranularity } from '../analytics-range';

// Cross-field range rules (from < to, at most 366 days) depend on the
// defaults, so they are enforced by resolveAnalyticsRange after validation.
export class AnalyticsQueryDto {
  /** Inclusive start; UTC when no zone is given. */
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  /** Exclusive end; UTC when no zone is given. */
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['day', 'week'])
  granularity: AnalyticsGranularity = 'day';
}
