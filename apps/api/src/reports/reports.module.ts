import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommentsModule } from '../comments/comments.module';
import { CommunitiesModule } from '../communities/communities.module';
import { DatabaseModule } from '../database/database.module';
import { PostsModule } from '../posts/posts.module';
import { CommunityReportsController } from './community-reports.controller';
import { CommunityReportsService } from './community-reports.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [
    AuthModule,
    CommentsModule,
    CommunitiesModule,
    DatabaseModule,
    PostsModule,
  ],
  providers: [ReportsService, CommunityReportsService],
  controllers: [ReportsController, CommunityReportsController],
})
export class ReportsModule {}
