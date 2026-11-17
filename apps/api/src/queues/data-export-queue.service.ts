import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisConfigService } from '../redis/redis-config.service';
import { DATA_EXPORT_QUEUE_NAME, DataExportJobData } from './queues.types';

export type DataExportHandler = (id: string, userId: string) => Promise<void>;

@Injectable()
export class DataExportQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataExportQueueService.name);
  private queue?: Queue<DataExportJobData>;
  private worker?: Worker<DataExportJobData>;
  private handler?: DataExportHandler;

  constructor(private readonly configService: RedisConfigService) {}

  registerHandler(handler: DataExportHandler): void {
    this.handler = handler;
  }

  onModuleInit(): void {
    if (!this.configService.isEnabled) {
      return;
    }

    const { host, port, password, db, tls } = this.configService.config;
    const connection = {
      host,
      port,
      password,
      db,
      tls: tls ? {} : undefined,
      maxRetriesPerRequest: null,
    };

    try {
      this.queue = new Queue<DataExportJobData>(DATA_EXPORT_QUEUE_NAME, {
        connection,
        defaultJobOptions: {
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: true,
          removeOnFail: 500,
        },
      });

      this.worker = new Worker<DataExportJobData>(
        DATA_EXPORT_QUEUE_NAME,
        async (job) => {
          if (this.handler) {
            await this.handler(job.data.exportId, job.data.userId);
          } else {
            this.logger.error(
              'No DataExportHandler registered to process export job.',
            );
          }
        },
        {
          connection,
          concurrency: 1, // Enforce strict single-worker concurrency to prevent DB starvation
        },
      );

      this.worker.on('failed', (job, err) => {
        this.logger.error(
          `Data export job ${job?.id} (user: ${job?.data?.userId}) failed: ${err.message}`,
        );
      });

      this.logger.log('BullMQ Data Export Queue and Worker initialized.');
    } catch (error) {
      this.logger.warn(
        `Failed to initialize BullMQ Data Export Queue: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async enqueue(exportId: string, userId: string): Promise<boolean> {
    if (this.queue) {
      try {
        await this.queue.add('build-export', { exportId, userId });
        return true;
      } catch (error) {
        this.logger.warn(
          `Failed to enqueue data export to BullMQ, will use direct setImmediate fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return false;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    if (this.queue) {
      await this.queue.close();
    }
  }
}
