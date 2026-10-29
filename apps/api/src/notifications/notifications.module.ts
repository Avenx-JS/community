import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [NotificationsController],
  providers: [NotificationInboxService, NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
