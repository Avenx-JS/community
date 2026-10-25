import { beforeEach, describe, expect, it } from '@jest/globals';
import { createHmac } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { AuthRateLimitService } from './auth-rate-limit.service';

describe('AuthRateLimitService', () => {
  let service: AuthRateLimitService;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let requestCount: number;
  let retryAfter: number;

  beforeEach(() => {
    calls = [];
    requestCount = 1;
    retryAfter = 900;
    const execute = (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT request_count')) {
        return Promise.resolve([
          [{ request_count: requestCount, retry_after: retryAfter }],
          [],
        ]);
      }
      return Promise.resolve([{ affectedRows: 1 }, []]);
    };
    service = new AuthRateLimitService({ execute } as unknown as Pool);
  });

  it('stores HMACed account identifiers in a shared database counter', async () => {
    await expect(
      service.enforceLogin('192.0.2.10', ' User@Example.COM '),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(4);
    expect(calls[0].sql).toContain('INSERT INTO auth_rate_limits');
    expect(calls[0].sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(calls[0].sql).toContain('DATE_SUB(UTC_TIMESTAMP()');
    const expectedHash = createHmac(
      'sha256',
      process.env.RATE_LIMIT_HASH_SECRET ??
        process.env.MYSQL_PASSWORD ??
        'community-local-rate-limit-secret',
    )
      .update('login:ip')
      .update('\0')
      .update('192.0.2.10')
      .digest('hex');
    expect(calls[0].values).toEqual([expectedHash]);
    expect(JSON.stringify(calls)).not.toContain('User@Example.COM');
    expect(JSON.stringify(calls)).not.toContain('192.0.2.10');
  });

  it('returns a retry delay when an account bucket exceeds its configured limit', async () => {
    requestCount = 11;
    retryAfter = 73;

    await expect(
      service.enforceLogin('192.0.2.10', 'member@example.com'),
    ).resolves.toBe(73);
  });

  it('applies IP and normalized account signals to registration and refresh', async () => {
    await service.enforceRegistration(
      '192.0.2.10',
      ' Sample_User ',
      ' SAMPLE@EXAMPLE.COM ',
    );
    expect(calls).toHaveLength(6);

    calls = [];
    await service.enforceRefresh('192.0.2.10', 'opaque-refresh-token');
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls)).not.toContain('opaque-refresh-token');
  });

  it('supports fixed-window expiry in the atomic upsert', async () => {
    await service.enforceRegistration(
      '192.0.2.10',
      'sample_user',
      'sample@example.com',
    );

    const upsert = calls.find((call) =>
      call.sql.startsWith('INSERT INTO auth_rate_limits'),
    );
    expect(
      upsert?.sql.match(/DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL 3600 SECOND\)/g),
    ).toHaveLength(2);
  });

  it('exposes the same shared counter for other API throttles', async () => {
    await expect(
      service.enforceSignals([
        {
          scope: 'posts:create:ip',
          value: '192.0.2.10',
          limit: 8,
          windowSeconds: 120,
        },
      ]),
    ).resolves.toBeNull();

    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain('INSERT INTO auth_rate_limits');
    expect(calls[0].sql).toContain('INTERVAL 120 SECOND');
  });

  it('adds report-specific IP and token-account signals with configurable defaults', async () => {
    await service.enforceApiRequest(
      '192.0.2.10',
      'POST',
      '/reports',
      'token-user-id',
    );

    expect(calls).toHaveLength(10);
    const hmac = (scope: string, value: string) =>
      createHmac(
        'sha256',
        process.env.RATE_LIMIT_HASH_SECRET ??
          process.env.MYSQL_PASSWORD ??
          'community-local-rate-limit-secret',
      )
        .update(scope)
        .update('\0')
        .update(value)
        .digest('hex');
    const reportSignals = calls.filter(
      (call) =>
        call.sql.startsWith('INSERT INTO auth_rate_limits') &&
        call.sql.includes('INTERVAL 3600 SECOND'),
    );
    expect(reportSignals.map((call) => call.values[0])).toEqual(
      expect.arrayContaining([
        hmac('report:create:ip', '192.0.2.10'),
        hmac('report:create:account', 'token-user-id'),
      ]),
    );
    expect(JSON.stringify(calls)).not.toContain('token-user-id');
  });

  it('honours report rate-limit environment overrides', async () => {
    const previousValues = {
      ipMax: process.env.API_REPORT_CREATE_IP_MAX,
      ipWindow: process.env.API_REPORT_CREATE_IP_WINDOW_SECONDS,
      accountMax: process.env.API_REPORT_CREATE_ACCOUNT_MAX,
      accountWindow: process.env.API_REPORT_CREATE_ACCOUNT_WINDOW_SECONDS,
    };
    process.env.API_REPORT_CREATE_IP_MAX = '4';
    process.env.API_REPORT_CREATE_IP_WINDOW_SECONDS = '120';
    process.env.API_REPORT_CREATE_ACCOUNT_MAX = '2';
    process.env.API_REPORT_CREATE_ACCOUNT_WINDOW_SECONDS = '180';
    try {
      const overridden = new AuthRateLimitService({
        execute: (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          return Promise.resolve([
            [{ request_count: 3, retry_after: 127 }],
            [],
          ]);
        },
      } as unknown as Pool);

      await expect(
        overridden.enforceApiRequest(
          '192.0.2.10',
          'POST',
          '/reports',
          'token-user-id',
        ),
      ).resolves.toBe(127);
      const reportWindows = calls
        .filter(
          (call) =>
            call.sql.startsWith('INSERT INTO auth_rate_limits') &&
            (call.sql.includes('INTERVAL 120 SECOND') ||
              call.sql.includes('INTERVAL 180 SECOND')),
        )
        .map((call) => call.sql);
      expect(reportWindows).toHaveLength(2);
    } finally {
      const envValues = [
        ['API_REPORT_CREATE_IP_MAX', previousValues.ipMax],
        ['API_REPORT_CREATE_IP_WINDOW_SECONDS', previousValues.ipWindow],
        ['API_REPORT_CREATE_ACCOUNT_MAX', previousValues.accountMax],
        [
          'API_REPORT_CREATE_ACCOUNT_WINDOW_SECONDS',
          previousValues.accountWindow,
        ],
      ] as const;
      for (const [name, value] of envValues) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it('shares API counters across service instances through the database store', async () => {
    const previousMax = process.env.API_READ_IP_MAX;
    process.env.API_READ_IP_MAX = '1';
    const sharedBuckets = new Map<string, number>();
    const sharedPool = {
      execute: (sql: string, values: unknown[]) => {
        const bucketKey = values[0] as string;
        if (sql.startsWith('INSERT INTO auth_rate_limits')) {
          sharedBuckets.set(bucketKey, (sharedBuckets.get(bucketKey) ?? 0) + 1);
          return Promise.resolve([{ affectedRows: 1 }, []] as [
            unknown,
            unknown,
          ]);
        }
        return Promise.resolve([
          [
            {
              request_count: sharedBuckets.get(bucketKey) ?? 0,
              retry_after: 60,
            },
          ],
          [],
        ] as [unknown, unknown]);
      },
    } as unknown as Pool;

    try {
      const firstInstance = new AuthRateLimitService(sharedPool);
      const secondInstance = new AuthRateLimitService(sharedPool);
      await expect(
        firstInstance.enforceApiRequest('192.0.2.10', 'GET', '/posts'),
      ).resolves.toBeNull();
      await expect(
        secondInstance.enforceApiRequest('192.0.2.10', 'GET', '/posts'),
      ).resolves.toBe(60);
      expect([...sharedBuckets.values()]).toEqual([2, 2]);
    } finally {
      if (previousMax === undefined) {
        delete process.env.API_READ_IP_MAX;
      } else {
        process.env.API_READ_IP_MAX = previousMax;
      }
    }
  });
});
