import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import type { AnalyticsGranularity } from '../analytics-range';

// Cross-field range rules (from < to, at most 366 days) depend on the
// defaults, so they are enforced by resolveAnalyticsRange after validation.
export class UserAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsIn(['day', 'week'])
  granularity: AnalyticsGranularity = 'day';
}
