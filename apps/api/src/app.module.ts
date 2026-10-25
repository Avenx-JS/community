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

@Module({
  imports: [
    AuthModule,
    UsersModule,
    CommunitiesModule,
    PostsModule,
    CommentsModule,
    VotesModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
