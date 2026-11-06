import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { readPositiveInteger } from '../common/read-positive-integer';
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
  passwordChangeIp: RateLimitOptions;
  passwordChangeAccount: RateLimitOptions;
  passwordForgotIp: RateLimitOptions;
  passwordForgotAccount: RateLimitOptions;
  passwordResetIp: RateLimitOptions;
  passwordResetToken: RateLimitOptions;
  registerIp: RateLimitOptions;
  registerAccount: RateLimitOptions;
  refreshIp: RateLimitOptions;
  refreshToken: RateLimitOptions;
  apiRequestIp: RateLimitOptions;
  apiReadIp: RateLimitOptions;
  apiWriteIp: RateLimitOptions;
  apiWriteAccount: RateLimitOptions;
  contentCreateIp: RateLimitOptions;
  contentCreateAccount: RateLimitOptions;
  contentCreateCooldown: RateLimitOptions;
  reportCreateIp: RateLimitOptions;
  reportCreateAccount: RateLimitOptions;
  accountDeleteIp: RateLimitOptions;
  accountDeleteAccount: RateLimitOptions;
}

const localDevelopmentSecret = 'community-local-rate-limit-secret';

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
    passwordChangeIp: readOptions('AUTH_PASSWORD_CHANGE_IP', 10, 3600),
    passwordChangeAccount: readOptions('AUTH_PASSWORD_CHANGE_ACCOUNT', 5, 3600),
    passwordForgotIp: readOptions('AUTH_PASSWORD_FORGOT_IP', 5, 3600),
    passwordForgotAccount: readOptions('AUTH_PASSWORD_FORGOT_ACCOUNT', 3, 3600),
    passwordResetIp: readOptions('AUTH_PASSWORD_RESET_IP', 20, 3600),
    passwordResetToken: readOptions('AUTH_PASSWORD_RESET_TOKEN', 5, 3600),
    registerIp: readOptions('AUTH_REGISTER_IP', 5, 3600),
    registerAccount: readOptions('AUTH_REGISTER_ACCOUNT', 3, 3600),
    refreshIp: readOptions('AUTH_REFRESH_IP', 30, 3600),
    refreshToken: readOptions('AUTH_REFRESH_TOKEN', 10, 3600),
    apiRequestIp: readOptions('API_REQUEST_IP', 300, 60),
    apiReadIp: readOptions('API_READ_IP', 120, 60),
    apiWriteIp: readOptions('API_WRITE_IP', 60, 60),
    apiWriteAccount: readOptions('API_WRITE_ACCOUNT', 120, 60),
    contentCreateIp: readOptions('API_CONTENT_CREATE_IP', 10, 600),
    contentCreateAccount: readOptions('API_CONTENT_CREATE_ACCOUNT', 5, 600),
    contentCreateCooldown: readOptions('API_CONTENT_COOLDOWN', 1, 30),
    reportCreateIp: readOptions('API_REPORT_CREATE_IP', 20, 3600),
    reportCreateAccount: readOptions('API_REPORT_CREATE_ACCOUNT', 10, 3600),
    accountDeleteIp: readOptions('API_ACCOUNT_DELETE_IP', 10, 86400),
    accountDeleteAccount: readOptions('API_ACCOUNT_DELETE_ACCOUNT', 5, 86400),
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

  // Password change verifies the current password, so it is a guessing
  // oracle for anyone holding a stolen access token.
  async enforcePasswordChange(
    ip: string,
    userId: string,
  ): Promise<number | null> {
    return this.enforceSignals([
      this.signal('password:change:ip', ip, this.config.passwordChangeIp),
      this.signal(
        'password:change:account',
        userId,
        this.config.passwordChangeAccount,
      ),
    ]);
  }

  // The per-address bucket is what stops this route being a mail-bombing tool
  // aimed at a third party. It counts every address alike, known or not, so a
  // 429 reveals nothing about which ones exist.
  async enforcePasswordForgot(
    ip: string,
    email: string,
  ): Promise<number | null> {
    return this.enforceSignals([
      this.signal('password:forgot:ip', ip, this.config.passwordForgotIp),
      this.signal(
        'password:forgot:email',
        email.trim().toLowerCase(),
        this.config.passwordForgotAccount,
      ),
    ]);
  }

  async enforcePasswordReset(
    ip: string,
    token: string,
  ): Promise<number | null> {
    return this.enforceSignals([
      this.signal('password:reset:ip', ip, this.config.passwordResetIp),
      this.signal(
        'password:reset:token',
        token,
        this.config.passwordResetToken,
      ),
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

  async enforceApiRequest(
    ip: string,
    method: string,
    path: string,
    accountId?: string,
  ): Promise<number | null> {
    const isRead = method === 'GET' || method === 'HEAD';
    const signals = [
      this.signal('api:request:ip', ip, this.config.apiRequestIp),
      this.signal(
        isRead ? 'api:read:ip' : 'api:write:ip',
        ip,
        isRead ? this.config.apiReadIp : this.config.apiWriteIp,
      ),
    ];

    if (!isRead && accountId) {
      signals.push(
        this.signal(
          'api:write:account',
          accountId,
          this.config.apiWriteAccount,
        ),
      );
    }

    if (
      method === 'POST' &&
      (path === '/posts' || /^\/posts\/[^/]+\/comments$/.test(path))
    ) {
      signals.push(
        this.signal('api:content:create:ip', ip, this.config.contentCreateIp),
      );
      if (accountId) {
        signals.push(
          this.signal(
            'api:content:create:account',
            accountId,
            this.config.contentCreateAccount,
          ),
          this.signal(
            'api:content:create:cooldown',
            accountId,
            this.config.contentCreateCooldown,
          ),
        );
      }
    }

    // Account deletion verifies a password, so it is also a password-guessing
    // oracle for anyone holding an access token.
    if (method === 'DELETE' && path === '/users/me') {
      signals.push(
        this.signal('account:delete:ip', ip, this.config.accountDeleteIp),
      );
      if (accountId) {
        signals.push(
          this.signal(
            'account:delete:account',
            accountId,
            this.config.accountDeleteAccount,
          ),
        );
      }
    }

    if (method === 'POST' && path === '/reports') {
      signals.push(
        this.signal('report:create:ip', ip, this.config.reportCreateIp),
      );
      if (accountId) {
        signals.push(
          this.signal(
            'report:create:account',
            accountId,
            this.config.reportCreateAccount,
          ),
        );
      }
    }

    return this.enforceSignals(signals);
  }

  async enforceSignals(signals: RateLimitSignal[]): Promise<number | null> {
    const retryAfters = await Promise.all(
      signals.map((signal) => this.consume(signal)),
    );
    const longestRetryAfter = Math.max(
      0,
      ...retryAfters.map((value) => value ?? 0),
    );
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
