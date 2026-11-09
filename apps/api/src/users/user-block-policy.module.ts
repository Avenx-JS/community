import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { UserBlockPolicyService } from './user-block-policy.service';

// Only the database: comments, votes, the inbox and the profile feeds import
// it without depending on UsersModule and its AuthModule cycle.
@Module({
  imports: [DatabaseModule],
  providers: [UserBlockPolicyService],
  exports: [UserBlockPolicyService],
})
export class UserBlockPolicyModule {}
