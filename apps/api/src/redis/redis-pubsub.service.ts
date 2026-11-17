import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { Subject } from 'rxjs';
import { REDIS_CLIENT, REDIS_SUBSCRIBER_CLIENT } from './redis.types';

export interface PubSubMessage<T = unknown> {
  channel: string;
  data: T;
}

@Injectable()
export class RedisPubSubService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private readonly localBus = new Subject<PubSubMessage>();
  private readonly subscribedChannels = new Set<string>();
  private readonly channelHandlers = new Map<
    string,
    Set<(data: unknown) => void>
  >();

  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly publisher?: Redis | null,
    @Optional()
    @Inject(REDIS_SUBSCRIBER_CLIENT)
    private readonly subscriber?: Redis | null,
  ) {
    if (this.subscriber) {
      this.subscriber.on('message', (channel: string, message: string) => {
        try {
          const parsed: unknown = JSON.parse(message);
          this.dispatch(channel, parsed);
        } catch {
          this.dispatch(channel, message);
        }
      });
    }
  }

  async publish(channel: string, data: unknown): Promise<void> {
    const payload = JSON.stringify(data);

    if (this.publisher) {
      try {
        await this.publisher.publish(channel, payload);
      } catch (error) {
        this.logger.warn(
          `Failed to publish to channel "${channel}" via Redis: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // Fallback to local dispatch
        this.dispatch(channel, data);
      }
    } else {
      // In-process fallback
      this.dispatch(channel, data);
    }
  }

  async subscribe<T = unknown>(
    channel: string,
    handler: (data: T) => void,
  ): Promise<() => void> {
    let handlers = this.channelHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channelHandlers.set(channel, handlers);
    }
    handlers.add(handler);

    if (this.subscriber && !this.subscribedChannels.has(channel)) {
      this.subscribedChannels.add(channel);
      try {
        await this.subscriber.subscribe(channel);
      } catch (error) {
        this.logger.warn(
          `Failed to subscribe to Redis channel "${channel}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.channelHandlers.delete(channel);
        if (this.subscriber && this.subscribedChannels.has(channel)) {
          this.subscribedChannels.delete(channel);
          void this.subscriber.unsubscribe(channel).catch(() => undefined);
        }
      }
    };
  }

  private dispatch(channel: string, data: unknown): void {
    const handlers = this.channelHandlers.get(channel);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (error) {
          this.logger.error(
            `Error in subscriber for channel "${channel}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    this.localBus.next({ channel, data });
  }

  onModuleDestroy(): void {
    this.localBus.complete();
    this.channelHandlers.clear();
    this.subscribedChannels.clear();
  }
}
