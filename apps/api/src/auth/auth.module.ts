import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [AuthService, AuthGuard, AuthRateLimitService],
  controllers: [AuthController],
  exports: [AuthGuard, AuthService, AuthRateLimitService],
})
export class AuthModule {}
