import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { DatabaseModule } from '../database/database.module';
import { UsersModule } from '../users/users.module';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [DatabaseModule, UsersModule],
  providers: [AuthService, AuthGuard, AdminGuard, AuthRateLimitService],
  controllers: [AuthController],
  exports: [AuthGuard, AdminGuard, AuthService, AuthRateLimitService],
})
export class AuthModule {}
