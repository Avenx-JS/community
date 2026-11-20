import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CommunitiesModule } from './communities/communities.module';
import { PostsModule } from './posts/posts.module';
import { CommentsModule } from './comments/comments.module';
import { VotesModule } from './votes/votes.module';
import { AdminModule } from './admin/admin.module';
import { AppealsModule } from './appeals/appeals.module';
import { ReportsModule } from './reports/reports.module';
import { SearchModule } from './search/search.module';
import { MediaModule } from './media/media.module';
import { ModmailModule } from './modmail/modmail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { EmailModule } from './email/email.module';
import { RedisModule } from './redis/redis.module';
import { QueuesModule } from './queues/queues.module';

@Module({
  imports: [
    RedisModule,
    QueuesModule,
    AuthModule,
    UsersModule,
    CommunitiesModule,
    PostsModule,
    CommentsModule,
    VotesModule,
    AdminModule,
    AppealsModule,
    ReportsModule,
    SearchModule,
    MediaModule,
    ModmailModule,
    NotificationsModule,
    EmailModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
