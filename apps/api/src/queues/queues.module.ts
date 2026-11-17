import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { EmailModule } from '../email/email.module';
import { EmailQueueService } from './email-queue.service';
import { DataExportQueueService } from './data-export-queue.service';

@Global()
@Module({
  imports: [RedisModule, EmailModule],
  providers: [EmailQueueService, DataExportQueueService],
  exports: [EmailQueueService, DataExportQueueService],
})
export class QueuesModule {}
