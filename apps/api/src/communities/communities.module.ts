import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CommunitiesService } from './communities.service';
import { CommunitiesController } from './communities.controller';
import { CommunityModerationLogController } from './community-moderation-log.controller';
import { CommunityModerationLogService } from './community-moderation-log.service';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';
import { CommunityRulesController } from './community-rules.controller';
import { CommunityRulesService } from './community-rules.service';
import { CommunityStatsService } from './community-stats.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { SubscriptionsController } from './subscriptions.controller';

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [
    CommunitiesService,
    CommunityModerationLogService,
    CommunityRuleAcceptanceService,
    CommunityRulesService,
    CommunityStatsService,
    NotificationPreferencesService,
  ],
  controllers: [
    CommunitiesController,
    CommunityModerationLogController,
    CommunityRulesController,
    SubscriptionsController,
  ],
  exports: [
    CommunitiesService,
    CommunityModerationLogService,
    CommunityRuleAcceptanceService,
  ],
})
export class CommunitiesModule {}
