import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [DatabaseModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
