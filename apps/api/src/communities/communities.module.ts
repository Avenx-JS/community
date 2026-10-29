import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CommunitiesService } from './communities.service';
import { CommunitiesController } from './communities.controller';
import { SubscriptionsController } from './subscriptions.controller';

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [CommunitiesService],
  controllers: [CommunitiesController, SubscriptionsController],
  exports: [CommunitiesService],
})
export class CommunitiesModule {}
