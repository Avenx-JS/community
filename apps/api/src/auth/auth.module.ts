import { forwardRef, Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { DatabaseModule } from '../database/database.module';
import { EmailModule } from '../email/email.module';
import { UsersModule } from '../users/users.module';
import { AdminGuard } from './admin.guard';
import { AccountEmailController } from './account-email.controller';
import { EmailVerificationService } from './email-verification.service';
import { SessionEvents } from './session-events';

@Module({
  imports: [DatabaseModule, EmailModule, forwardRef(() => UsersModule)],
  providers: [
    AuthService,
    AuthGuard,
    AdminGuard,
    AuthRateLimitService,
    EmailVerificationService,
    SessionEvents,
  ],
  controllers: [AuthController, AccountEmailController],
  exports: [
    AuthGuard,
    AdminGuard,
    AuthService,
    AuthRateLimitService,
    SessionEvents,
  ],
})
export class AuthModule {}
