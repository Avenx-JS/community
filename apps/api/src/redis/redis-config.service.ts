import { Injectable } from '@nestjs/common';
import type { RedisConfig } from './redis.types';

@Injectable()
export class RedisConfigService {
  readonly config: RedisConfig;

  constructor() {
    const enabledEnv = process.env.REDIS_ENABLED;
    const isExplicitlyDisabled = enabledEnv === 'false' || enabledEnv === '0';
    const isExplicitlyEnabled = enabledEnv === 'true' || enabledEnv === '1';

    // Enabled if explicitly true, or if REDIS_HOST/REDIS_URL is configured unless explicitly disabled
    const hasHost = Boolean(process.env.REDIS_HOST || process.env.REDIS_URL);
    const enabled = isExplicitlyEnabled || (!isExplicitlyDisabled && hasHost);

    const portVal = Number(process.env.REDIS_PORT ?? 6379);
    const dbVal = Number(process.env.REDIS_DB ?? 0);

    this.config = {
      enabled,
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number.isSafeInteger(portVal) && portVal > 0 ? portVal : 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number.isSafeInteger(dbVal) && dbVal >= 0 ? dbVal : 0,
      keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'avenx:',
      tls: process.env.REDIS_TLS === 'true',
    };
  }

  get isEnabled(): boolean {
    return this.config.enabled;
  }
}

