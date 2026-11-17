import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import Redis from 'ioredis';
import { RedisConfigService } from './redis-config.service';
import {
  CacheService,
  RateLimiterStore,
  REDIS_CLIENT,
  REDIS_SUBSCRIBER_CLIENT,
} from './redis.types';
import { RedisRateLimiterStore } from './redis-rate-limiter.store';
import { RedisCacheService } from './redis-cache.service';
import { MemoryRateLimiterStore } from './fallbacks/memory-rate-limiter.store';
import { MemoryCacheService } from './fallbacks/memory-cache.service';
import { RedisPubSubService } from './redis-pubsub.service';

@Global()
@Module({
  providers: [
    RedisConfigService,
    MemoryRateLimiterStore,
    MemoryCacheService,
    {
      provide: REDIS_CLIENT,
      inject: [RedisConfigService],
      useFactory: async (
        configService: RedisConfigService,
      ): Promise<Redis | null> => {
        const logger = new Logger('RedisClient');
        if (!configService.isEnabled) {
          logger.log(
            'Redis is disabled. Using in-memory caching and rate limiting.',
          );
          return null;
        }

        const { host, port, password, db, keyPrefix, tls } =
          configService.config;
        try {
          const client = new Redis({
            host,
            port,
            password,
            db,
            keyPrefix,
            tls: tls ? {} : undefined,
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
              const delay = Math.min(times * 100, 3000);
              return delay;
            },
          });

          client.on('error', (err) => {
            logger.warn(`Redis connection error: ${err.message}`);
          });

          client.on('connect', () => {
            logger.log(`Connected to Redis at ${host}:${port}`);
          });

          await client.connect();
          return client;
        } catch (error) {
          logger.error(
            `Failed to initialize Redis client, falling back to memory: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }
      },
    },
    {
      provide: REDIS_SUBSCRIBER_CLIENT,
      inject: [RedisConfigService],
      useFactory: async (
        configService: RedisConfigService,
      ): Promise<Redis | null> => {
        const logger = new Logger('RedisSubscriber');
        if (!configService.isEnabled) {
          return null;
        }

        const { host, port, password, db, tls } = configService.config;
        try {
          // Subscribers do not use keyPrefix because Pub/Sub channel names are global
          const subscriber = new Redis({
            host,
            port,
            password,
            db,
            tls: tls ? {} : undefined,
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: null,
            retryStrategy: (times) => Math.min(times * 100, 3000),
          });

          subscriber.on('error', (err) => {
            logger.warn(`Redis subscriber error: ${err.message}`);
          });

          await subscriber.connect();
          return subscriber;
        } catch (error) {
          logger.warn(
            `Failed to initialize Redis subscriber, falling back to local bus: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }
      },
    },
    {
      provide: RateLimiterStore,
      inject: [RedisConfigService, REDIS_CLIENT, MemoryRateLimiterStore],
      useFactory: (
        configService: RedisConfigService,
        redisClient: Redis | null,
        memoryStore: MemoryRateLimiterStore,
      ): RateLimiterStore => {
        if (configService.isEnabled && redisClient) {
          return new RedisRateLimiterStore(redisClient);
        }
        return memoryStore;
      },
    },
    {
      provide: CacheService,
      inject: [RedisConfigService, REDIS_CLIENT, MemoryCacheService],
      useFactory: (
        configService: RedisConfigService,
        redisClient: Redis | null,
        memoryCache: MemoryCacheService,
      ): CacheService => {
        if (configService.isEnabled && redisClient) {
          return new RedisCacheService(redisClient);
        }
        return memoryCache;
      },
    },
    RedisPubSubService,
  ],
  exports: [
    RedisConfigService,
    REDIS_CLIENT,
    REDIS_SUBSCRIBER_CLIENT,
    RateLimiterStore,
    CacheService,
    RedisPubSubService,
  ],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redisClient?: Redis | null,
    @Optional()
    @Inject(REDIS_SUBSCRIBER_CLIENT)
    private readonly subscriberClient?: Redis | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redisClient && this.redisClient.status !== 'end') {
      try {
        await this.redisClient.quit();
        this.logger.log('Redis client connection closed.');
      } catch {
        this.redisClient.disconnect();
      }
    }
    if (this.subscriberClient && this.subscriberClient.status !== 'end') {
      try {
        await this.subscriberClient.quit();
        this.logger.log('Redis subscriber connection closed.');
      } catch {
        this.subscriberClient.disconnect();
      }
    }
  }
}
