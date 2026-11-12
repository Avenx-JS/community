import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommunitiesModule } from '../communities/communities.module';
import { DatabaseModule } from '../database/database.module';
import { UserBlockPolicyModule } from '../users/user-block-policy.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VotesModule } from '../votes/votes.module';
import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';
import { CommentLocksController } from './comment-locks.controller';
import { CommentLocksService } from './comment-locks.service';
import { CommentRemovalsController } from './comment-removals.controller';
import { CommentRemovalService } from './comment-removals.service';

@Module({
  imports: [
    AuthModule,
    CommunitiesModule,
    DatabaseModule,
    NotificationsModule,
    VotesModule,
    UserBlockPolicyModule,
  ],
  providers: [CommentsService, CommentLocksService, CommentRemovalService],
  controllers: [
    CommentsController,
    CommentLocksController,
    CommentRemovalsController,
  ],
  exports: [CommentsService, CommentRemovalService],
})
export class CommentsModule {}
