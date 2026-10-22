import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommentsModule } from '../comments/comments.module';
import { DatabaseModule } from '../database/database.module';
import { PostsService } from './posts.service';
import { PostsController } from './posts.controller';

@Module({
  imports: [AuthModule, CommentsModule, DatabaseModule],
  providers: [PostsService],
  controllers: [PostsController],
})
export class PostsModule {}
