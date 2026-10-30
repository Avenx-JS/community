import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminAuditLogController } from './admin-audit-log.controller';
import { AdminAuditLogService } from './admin-audit-log.service';
import { AdminReportsController } from './admin-reports.controller';
import { AdminReportsService } from './admin-reports.service';
import { AdminRestrictionsController } from './admin-restrictions.controller';
import { AdminRestrictionsService } from './admin-restrictions.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AuditLogService } from './audit-log.service';

@Module({
  imports: [AuthModule, DatabaseModule, NotificationsModule, UsersModule],
  controllers: [
    AdminReportsController,
    AdminUsersController,
    AdminRestrictionsController,
    AdminAuditLogController,
    AdminAnalyticsController,
  ],
  providers: [
    AdminAnalyticsService,
    AdminAuditLogService,
    AdminReportsService,
    AdminUsersService,
    AdminRestrictionsService,
    AuditLogService,
  ],
})
export class AdminModule {}
