import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CommunitiesService } from './communities.service';
import { CommunitiesController } from './communities.controller';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';
import { CommunityRulesController } from './community-rules.controller';
import { CommunityRulesService } from './community-rules.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { SubscriptionsController } from './subscriptions.controller';

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [
    CommunitiesService,
    CommunityRuleAcceptanceService,
    CommunityRulesService,
    NotificationPreferencesService,
  ],
  controllers: [
    CommunitiesController,
    CommunityRulesController,
    SubscriptionsController,
  ],
  exports: [CommunitiesService, CommunityRuleAcceptanceService],
})
export class CommunitiesModule {}
