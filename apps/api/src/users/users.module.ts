import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { UserBlockPolicyModule } from './user-block-policy.module';
import { AccountDeletionService } from './account-deletion.service';
import { UserActivityService } from './user-activity.service';
import { UserBlocksController } from './user-blocks.controller';
import { UserBlocksService } from './user-blocks.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AccountDataController } from './account-data.controller';
import { DataExportService } from './data-export.service';
import { UserPreferencesService } from './user-preferences.service';

@Module({
  // AuthModule needs UsersService for AdminGuard, and UsersController needs
  // AuthGuard (and AccountDeletionService AuthService) for /users/me.
  imports: [
    DatabaseModule,
    UserBlockPolicyModule,
    forwardRef(() => AuthModule),
  ],
  providers: [
    UsersService,
    AccountDeletionService,
    UserActivityService,
    UserBlocksService,
    UserPreferencesService,
    DataExportService,
  ],
  controllers: [UsersController, UserBlocksController, AccountDataController],
  exports: [UsersService],
})
export class UsersModule {}
