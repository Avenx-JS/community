import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommunitiesModule } from '../communities/communities.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';

@Module({
  imports: [AuthModule, CommunitiesModule, DatabaseModule, NotificationsModule],
  providers: [CommentsService],
  controllers: [CommentsController],
  exports: [CommentsService],
})
export class CommentsModule {}
