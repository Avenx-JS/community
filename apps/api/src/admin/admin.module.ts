import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { UsersModule } from '../users/users.module';
import { AdminReportsController } from './admin-reports.controller';
import { AdminReportsService } from './admin-reports.service';
import { AdminRestrictionsController } from './admin-restrictions.controller';
import { AdminRestrictionsService } from './admin-restrictions.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AuditLogService } from './audit-log.service';

@Module({
  imports: [AuthModule, DatabaseModule, UsersModule],
  controllers: [
    AdminReportsController,
    AdminUsersController,
    AdminRestrictionsController,
  ],
  providers: [
    AdminReportsService,
    AdminUsersService,
    AdminRestrictionsService,
    AuditLogService,
  ],
})
export class AdminModule {}
