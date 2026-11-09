import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CommunitiesService } from './communities.service';
import { CommunitiesController } from './communities.controller';
import { CommunityBansController } from './community-bans.controller';
import { CommunityBanPolicyService } from './community-ban-policy.service';
import { CommunityBansService } from './community-bans.service';
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
    CommunityBanPolicyService,
    CommunityBansService,
    CommunityModerationLogService,
    CommunityRuleAcceptanceService,
    CommunityRulesService,
    CommunityStatsService,
    NotificationPreferencesService,
  ],
  controllers: [
    CommunitiesController,
    CommunityBansController,
    CommunityModerationLogController,
    CommunityRulesController,
    SubscriptionsController,
  ],
  exports: [
    CommunitiesService,
    CommunityBanPolicyService,
    CommunityModerationLogService,
    CommunityRuleAcceptanceService,
  ],
})
export class CommunitiesModule {}
