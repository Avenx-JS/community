import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisConfigService } from '../redis/redis-config.service';
import { EmailTransport, OutboundMessage } from '../email/email-transport';
import { EMAIL_QUEUE_NAME, EmailJobData } from './queues.types';

@Injectable()
export class EmailQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailQueueService.name);
  private queue?: Queue<EmailJobData>;
  private worker?: Worker<EmailJobData>;

  constructor(
    private readonly configService: RedisConfigService,
    private readonly emailTransport: EmailTransport,
  ) {}

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
      this.queue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
        connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: true,
          removeOnFail: 1000,
        },
      });

      this.worker = new Worker<EmailJobData>(
        EMAIL_QUEUE_NAME,
        async (job) => {
          await this.emailTransport.send(job.data);
        },
        {
          connection,
          concurrency: 10,
        },
      );

      this.worker.on('failed', (job, err) => {
        this.logger.error(
          `Email delivery failed for job ${job?.id} (recipient: ${job?.data?.to}): ${err.message}`,
        );
      });

      this.logger.log('BullMQ Email Queue and Worker initialized.');
    } catch (error) {
      this.logger.warn(
        `Failed to initialize BullMQ Email Queue, will use direct delivery: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async enqueue(message: OutboundMessage): Promise<void> {
    if (this.queue) {
      try {
        await this.queue.add('send-email', message);
        return;
      } catch (error) {
        this.logger.warn(
          `Failed to enqueue email to BullMQ, falling back to direct delivery: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Direct synchronous fallback if queue is disabled or enqueue fails
    await this.emailTransport.send(message);
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

