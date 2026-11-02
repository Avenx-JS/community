import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AccountDeletionService } from './account-deletion.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // AuthModule needs UsersService for AdminGuard, and UsersController needs
  // AuthGuard (and AccountDeletionService AuthService) for /users/me.
  imports: [DatabaseModule, forwardRef(() => AuthModule)],
  providers: [UsersService, AccountDeletionService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
