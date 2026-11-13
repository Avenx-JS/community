import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommunitiesModule } from '../communities/communities.module';
import { CommentsModule } from '../comments/comments.module';
import { DatabaseModule } from '../database/database.module';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VotesModule } from '../votes/votes.module';
import { PostsService } from './posts.service';
import { CommunityPostsController } from './community-posts.controller';
import { FeedController } from './feed.controller';
import { PostsController } from './posts.controller';
import { SavedPostsController } from './saved-posts.controller';
import { SavedPostsService } from './saved-posts.service';
import { ContentRevisionsService } from './content-revisions.service';
import {
  CommentViewsController,
  OwnContentController,
  PostViewsController,
} from './content-views.controller';
import { HiddenPostsService } from './hidden-posts.service';
import { PostLabelsService } from './post-labels.service';
import { SavedCommentsService } from './saved-comments.service';
import { VoteHistoryService } from './vote-history.service';

@Module({
  imports: [
    AuthModule,
    CommunitiesModule,
    CommentsModule,
    DatabaseModule,
    MediaModule,
    NotificationsModule,
    VotesModule,
  ],
  providers: [
    PostsService,
    SavedPostsService,
    ContentRevisionsService,
    HiddenPostsService,
    PostLabelsService,
    SavedCommentsService,
    VoteHistoryService,
  ],
  exports: [PostsService],
  controllers: [
    PostsController,
    CommunityPostsController,
    SavedPostsController,
    FeedController,
    PostViewsController,
    CommentViewsController,
    OwnContentController,
  ],
})
export class PostsModule {}
