import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommunitiesModule } from '../communities/communities.module';
import { DatabaseModule } from '../database/database.module';
import { UserBlockPolicyModule } from '../users/user-block-policy.module';
import { VotesService } from './votes.service';

@Module({
  imports: [
    AuthModule,
    CommunitiesModule,
    DatabaseModule,
    UserBlockPolicyModule,
  ],
  providers: [VotesService],
  exports: [VotesService],
})
export class VotesModule {}
