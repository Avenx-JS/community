import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { ApiAuthenticated, ApiErrorResponses } from '../common/openapi';
import { AdminAnalyticsService } from './admin-analytics.service';
import { ADMIN_ONLY } from './admin.openapi';
import {
  ModerationAnalyticsResponse,
  UserAnalyticsResponse,
} from './admin.responses';
import { resolveAnalyticsRange } from './analytics-range';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

const rangeDescription =
  'The range is half-open [from, to), defaults to the last 30 days, and ' +
  'may span at most 366 days.';

@ApiTags('admin: analytics')
@Controller('admin/analytics')
@UseGuards(AuthGuard, AdminGuard)
export class AdminAnalyticsController {
  constructor(private readonly analyticsService: AdminAnalyticsService) {}

  @Get('users')
  @ApiOperation({ summary: 'User metrics', description: rangeDescription })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: UserAnalyticsResponse })
  @ApiErrorResponses({ 400: 'Invalid range or granularity.' })
  users(@Query() query: AnalyticsQueryDto) {
    const now = new Date();
    return this.analyticsService.userMetrics(
      resolveAnalyticsRange(query, now),
      query.granularity ?? 'day',
      now,
    );
  }

  @Get('moderation')
  @ApiOperation({
    summary: 'Moderation metrics',
    description: rangeDescription,
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: ModerationAnalyticsResponse })
  @ApiErrorResponses({ 400: 'Invalid range or granularity.' })
  moderation(@Query() query: AnalyticsQueryDto) {
    const now = new Date();
    return this.analyticsService.moderationMetrics(
      resolveAnalyticsRange(query, now),
      query.granularity ?? 'day',
      now,
    );
  }
}
