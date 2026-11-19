import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  CommunityModmailController,
  OwnModmailController,
} from './modmail.controller';
import { ModmailService } from './modmail.service';

@Module({
  imports: [AuthModule, DatabaseModule, NotificationsModule],
  controllers: [CommunityModmailController, OwnModmailController],
  providers: [ModmailService],
})
export class ModmailModule {}
