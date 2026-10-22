import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { VotesService } from './votes.service';
import { VotesController } from './votes.controller';

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [VotesService],
  controllers: [VotesController],
})
export class VotesModule {}
