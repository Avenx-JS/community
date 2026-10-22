import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from './auth.service';

export interface RateLimitSignal {
  scope: string;
  value: string;
  limit: number;
  windowSeconds: number;
}

interface RateLimitRow extends RowDataPacket {
  request_count: number;
  retry_after: number;
}

interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
}

interface AuthRateLimitConfig {
  loginIp: RateLimitOptions;
  loginAccount: RateLimitOptions;
  registerIp: RateLimitOptions;
  registerAccount: RateLimitOptions;
  refreshIp: RateLimitOptions;
  refreshToken: RateLimitOptions;
}

const localDevelopmentSecret = 'community-local-rate-limit-secret';

function readPositiveInteger(name: string, fallback: number): number {
  const configured = process.env[name];
  if (configured === undefined) {
    return fallback;
  }

  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1 || value > 86400) {
    throw new Error(`${name} must be an integer between 1 and 86400`);
  }
  return value;
}

function readOptions(
  prefix: string,
  defaultLimit: number,
  defaultWindowSeconds: number,
): RateLimitOptions {
  return {
    limit: readPositiveInteger(`${prefix}_MAX`, defaultLimit),
    windowSeconds: readPositiveInteger(
      `${prefix}_WINDOW_SECONDS`,
      defaultWindowSeconds,
    ),
  };
}

function readConfig(): AuthRateLimitConfig {
  return {
    loginIp: readOptions('AUTH_LOGIN_IP', 20, 900),
    loginAccount: readOptions('AUTH_LOGIN_ACCOUNT', 10, 900),
    registerIp: readOptions('AUTH_REGISTER_IP', 5, 3600),
    registerAccount: readOptions('AUTH_REGISTER_ACCOUNT', 3, 3600),
    refreshIp: readOptions('AUTH_REFRESH_IP', 30, 3600),
    refreshToken: readOptions('AUTH_REFRESH_TOKEN', 10, 3600),
  };
}

@Injectable()
export class AuthRateLimitService {
  private readonly config = readConfig();
  private readonly hashSecret: string;

  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {
    const secret =
      process.env.RATE_LIMIT_HASH_SECRET ?? process.env.MYSQL_PASSWORD;
    if (!secret && process.env.NODE_ENV === 'production') {
      throw new Error(
        'RATE_LIMIT_HASH_SECRET must be configured in production',
      );
    }
    this.hashSecret = secret ?? localDevelopmentSecret;
  }

  async enforceLogin(ip: string, identifier: string): Promise<number | null> {
    const account = identifier.trim().toLowerCase();
    return this.enforceSignals([
      this.signal('login:ip', ip, this.config.loginIp),
      this.signal('login:account', account, this.config.loginAccount),
    ]);
  }

  async enforceRegistration(
    ip: string,
    username: string,
    email: string,
  ): Promise<number | null> {
    return this.enforceSignals([
      this.signal('register:ip', ip, this.config.registerIp),
      this.signal(
        'register:username',
        username.trim().toLowerCase(),
        this.config.registerAccount,
      ),
      this.signal(
        'register:email',
        email.trim().toLowerCase(),
        this.config.registerAccount,
      ),
    ]);
  }

  async enforceRefresh(
    ip: string,
    refreshToken: string,
  ): Promise<number | null> {
    return this.enforceSignals([
      this.signal('refresh:ip', ip, this.config.refreshIp),
      this.signal('refresh:token', refreshToken, this.config.refreshToken),
    ]);
  }

  async enforceSignals(signals: RateLimitSignal[]): Promise<number | null> {
    let longestRetryAfter = 0;

    for (const signal of signals) {
      const retryAfter = await this.consume(signal);
      if (retryAfter !== null) {
        longestRetryAfter = Math.max(longestRetryAfter, retryAfter);
      }
    }

    return longestRetryAfter > 0 ? longestRetryAfter : null;
  }

  private async consume(signal: RateLimitSignal): Promise<number | null> {
    const windowSeconds = signal.windowSeconds;
    const bucketKey = this.hashSignal(signal.scope, signal.value);
    await this.pool.execute(
      `INSERT INTO auth_rate_limits (bucket_key, window_started_at, request_count)
       VALUES (?, UTC_TIMESTAMP(), 1)
       ON DUPLICATE KEY UPDATE
         request_count = IF(
           window_started_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${windowSeconds} SECOND),
           1,
           request_count + 1
         ),
         window_started_at = IF(
           window_started_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${windowSeconds} SECOND),
           UTC_TIMESTAMP(),
           window_started_at
         )`,
      [bucketKey],
    );

    const [rows] = await this.pool.execute<RateLimitRow[]>(
      `SELECT request_count,
         GREATEST(
           1,
           TIMESTAMPDIFF(
             SECOND,
             UTC_TIMESTAMP(),
             DATE_ADD(window_started_at, INTERVAL ${windowSeconds} SECOND)
           )
         ) AS retry_after
       FROM auth_rate_limits
       WHERE bucket_key = ?
       LIMIT 1`,
      [bucketKey],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('Rate-limit bucket could not be retrieved');
    }

    return row.request_count > signal.limit ? row.retry_after : null;
  }

  private signal(
    scope: string,
    value: string,
    options: RateLimitOptions,
  ): RateLimitSignal {
    return { scope, value, ...options };
  }

  private hashSignal(scope: string, value: string): string {
    return createHmac('sha256', this.hashSecret)
      .update(scope)
      .update('\0')
      .update(value)
      .digest('hex');
  }
}
