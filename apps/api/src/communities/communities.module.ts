import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CommunitiesService } from './communities.service';
import { CommunitiesController } from './communities.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import { SubscriptionsController } from './subscriptions.controller';

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [CommunitiesService, NotificationPreferencesService],
  controllers: [CommunitiesController, SubscriptionsController],
  exports: [CommunitiesService],
})
export class CommunitiesModule {}
