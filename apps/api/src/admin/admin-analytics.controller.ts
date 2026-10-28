import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AdminAnalyticsService } from './admin-analytics.service';
import { resolveAnalyticsRange } from './analytics-range';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

@Controller('admin/analytics')
@UseGuards(AuthGuard, AdminGuard)
export class AdminAnalyticsController {
  constructor(private readonly analyticsService: AdminAnalyticsService) {}

  @Get('users')
  users(@Query() query: AnalyticsQueryDto) {
    const now = new Date();
    return this.analyticsService.userMetrics(
      resolveAnalyticsRange(query, now),
      query.granularity ?? 'day',
      now,
    );
  }

  @Get('moderation')
  moderation(@Query() query: AnalyticsQueryDto) {
    const now = new Date();
    return this.analyticsService.moderationMetrics(
      resolveAnalyticsRange(query, now),
      query.granularity ?? 'day',
      now,
    );
  }
}
