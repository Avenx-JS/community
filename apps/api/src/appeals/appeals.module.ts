import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { AdminAppealsService } from './admin-appeals.service';
import {
  AdminAppealsController,
  AppealsController,
} from './appeals.controller';
import { AppealsService } from './appeals.service';

// AdminModule provides the services an approval reverses the decision
// through; UsersModule the UsersService AdminGuard reads roles with.
@Module({
  imports: [
    AdminModule,
    AuthModule,
    DatabaseModule,
    NotificationsModule,
    UsersModule,
  ],
  controllers: [AppealsController, AdminAppealsController],
  providers: [AppealsService, AdminAppealsService],
})
export class AppealsModule {}
