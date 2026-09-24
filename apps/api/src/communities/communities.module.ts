import { Module } from '@nestjs/common';
import { CommunitiesService } from './communities.service';
import { CommunitiesController } from './communities.controller';

@Module({
  providers: [CommunitiesService],
  controllers: [CommunitiesController]
})
export class CommunitiesModule {}
