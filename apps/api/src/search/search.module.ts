import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [SearchService],
  controllers: [SearchController],
})
export class SearchModule {}
