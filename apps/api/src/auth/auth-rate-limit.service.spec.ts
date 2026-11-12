import { beforeEach, describe, expect, it } from '@jest/globals';
import { createHmac } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { AuthRateLimitService, isMediaUpload } from './auth-rate-limit.service';

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

  it('applies IP and normalized address signals to password reset requests', async () => {
    await service.enforcePasswordForgot('192.0.2.10', ' Member@Example.COM ');
    const first = JSON.stringify(calls);
    expect(calls).toHaveLength(4);
    expect(first.toLowerCase()).not.toContain('member@example.com');

    calls = [];
    await service.enforcePasswordForgot('192.0.2.10', 'member@example.com');
    expect(JSON.stringify(calls)).toBe(first);
  });

  it('applies IP and token signals to password resets, never storing the token', async () => {
    await service.enforcePasswordReset('192.0.2.10', 'opaque-reset-token');
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls)).not.toContain('opaque-reset-token');
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

  it('adds daily account-deletion IP and token-account signals', async () => {
    await service.enforceApiRequest(
      '192.0.2.10',
      'DELETE',
      '/users/me',
      'token-user-id',
    );

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
    const deletionSignals = calls.filter(
      (call) =>
        call.sql.startsWith('INSERT INTO auth_rate_limits') &&
        call.sql.includes('INTERVAL 86400 SECOND'),
    );
    expect(deletionSignals.map((call) => call.values[0])).toEqual([
      hmac('account:delete:ip', '192.0.2.10'),
      hmac('account:delete:account', 'token-user-id'),
    ]);
    expect(JSON.stringify(calls)).not.toContain('token-user-id');

    calls.length = 0;
    await service.enforceApiRequest('192.0.2.10', 'GET', '/users/me', 'id');
    await service.enforceApiRequest('192.0.2.10', 'PATCH', '/users/me', 'id');
    expect(
      calls.filter((call) => call.sql.includes('INTERVAL 86400 SECOND')),
    ).toEqual([]);
  });

  it('applies hourly password-change IP and account signals', async () => {
    await expect(
      service.enforcePasswordChange('192.0.2.10', 'token-user-id'),
    ).resolves.toBeNull();

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
    const upserts = calls.filter((call) =>
      call.sql.startsWith('INSERT INTO auth_rate_limits'),
    );
    expect(upserts.map((call) => call.values[0])).toEqual([
      hmac('password:change:ip', '192.0.2.10'),
      hmac('password:change:account', 'token-user-id'),
    ]);
    expect(
      upserts.every((call) => call.sql.includes('INTERVAL 3600 SECOND')),
    ).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('token-user-id');
  });

  it('counts GET /communities/:name/stats against the read bucket, with no exemption', async () => {
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

    await service.enforceApiRequest(
      '192.0.2.10',
      'GET',
      '/communities/gardening/stats',
      undefined,
    );

    const keys = calls
      .filter((call) => call.sql.startsWith('INSERT INTO auth_rate_limits'))
      .map((call) => call.values[0]);
    expect(keys).toContain(hmac('api:read:ip', '192.0.2.10'));
    expect(keys).not.toContain(hmac('api:write:ip', '192.0.2.10'));
  });

  it.each(['PATCH', 'DELETE'])(
    'counts %s /communities/:name against the write buckets',
    async (method) => {
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

      await service.enforceApiRequest(
        '192.0.2.10',
        method,
        '/communities/gardening',
        'creator-id',
      );

      const keys = calls
        .filter((call) => call.sql.startsWith('INSERT INTO auth_rate_limits'))
        .map((call) => call.values[0]);
      expect(keys).toContain(hmac('api:write:ip', '192.0.2.10'));
      expect(keys).toContain(hmac('api:write:account', 'creator-id'));
      expect(keys).not.toContain(hmac('api:read:ip', '192.0.2.10'));
    },
  );

  it.each([
    ['AUTH_PASSWORD_CHANGE_IP', 11],
    ['AUTH_PASSWORD_CHANGE_ACCOUNT', 6],
  ])(
    'denies password changes past the default %s limit',
    async (_prefix, count) => {
      requestCount = count;
      retryAfter = 1800;

      await expect(
        service.enforcePasswordChange('192.0.2.10', 'token-user-id'),
      ).resolves.toBe(1800);
    },
  );

  it('honours password-change rate-limit environment overrides', async () => {
    const names = [
      'AUTH_PASSWORD_CHANGE_IP_MAX',
      'AUTH_PASSWORD_CHANGE_IP_WINDOW_SECONDS',
      'AUTH_PASSWORD_CHANGE_ACCOUNT_MAX',
      'AUTH_PASSWORD_CHANGE_ACCOUNT_WINDOW_SECONDS',
    ] as const;
    const previous = names.map((name) => process.env[name]);
    process.env.AUTH_PASSWORD_CHANGE_IP_MAX = '3';
    process.env.AUTH_PASSWORD_CHANGE_IP_WINDOW_SECONDS = '120';
    process.env.AUTH_PASSWORD_CHANGE_ACCOUNT_MAX = '2';
    process.env.AUTH_PASSWORD_CHANGE_ACCOUNT_WINDOW_SECONDS = '180';
    try {
      const overridden = new AuthRateLimitService({
        execute: (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          return Promise.resolve([[{ request_count: 3, retry_after: 99 }], []]);
        },
      } as unknown as Pool);

      // 3 requests exceed the account limit of 2 but not the IP limit of 3.
      await expect(
        overridden.enforcePasswordChange('192.0.2.10', 'token-user-id'),
      ).resolves.toBe(99);
      const windows = calls
        .filter((call) => call.sql.startsWith('INSERT INTO auth_rate_limits'))
        .map((call) => /INTERVAL (\d+) SECOND/.exec(call.sql)?.[1]);
      expect(windows).toEqual(['120', '180']);
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = previous[index];
        }
      });
    }
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

  // GET /search reads a full-text index over every post: the general read
  // bucket is far too loose for it.
  it('gives GET /search its own configurable per-IP bucket, and only it', async () => {
    const names = ['API_SEARCH_IP_MAX', 'API_SEARCH_IP_WINDOW_SECONDS'];
    const previous = names.map((name) => process.env[name]);
    process.env.API_SEARCH_IP_MAX = '2';
    process.env.API_SEARCH_IP_WINDOW_SECONDS = '45';
    try {
      const searchCalls: Array<{ sql: string; values: unknown[] }> = [];
      const overridden = new AuthRateLimitService({
        execute: (sql: string, values: unknown[]) => {
          searchCalls.push({ sql, values });
          return Promise.resolve([[{ request_count: 3, retry_after: 41 }], []]);
        },
      } as unknown as Pool);
      const searchWindows = () =>
        searchCalls.filter(
          ({ sql }) =>
            sql.startsWith('INSERT INTO auth_rate_limits') &&
            sql.includes('INTERVAL 45 SECOND'),
        );

      await expect(
        overridden.enforceApiRequest('192.0.2.10', 'GET', '/search'),
      ).resolves.toBe(41);
      expect(searchWindows()).toHaveLength(1);

      searchCalls.length = 0;
      for (const [method, path] of [
        ['GET', '/posts'],
        ['GET', '/communities'],
        ['GET', '/search/anything'],
        ['POST', '/search'],
      ]) {
        await overridden.enforceApiRequest('192.0.2.10', method, path);
      }
      expect(searchWindows()).toHaveLength(0);
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = previous[index];
        }
      });
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

  // Every route that takes a file decodes or stores it: a bucket of its
  // own, beside the write buckets every write counts against.
  it.each([
    ['POST', '/media'],
    ['PUT', '/users/me/avatar'],
    ['PUT', '/communities/gardening/icon'],
    ['PUT', '/communities/gardening/banner'],
  ])(
    'counts %s %s against the media upload and write buckets',
    async (method, path) => {
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

      await service.enforceApiRequest('192.0.2.10', method, path, 'account-1');

      const keys = calls
        .filter((call) => call.sql.startsWith('INSERT INTO auth_rate_limits'))
        .map((call) => call.values[0]);
      expect(keys).toEqual(
        expect.arrayContaining([
          hmac('api:media:upload:ip', '192.0.2.10'),
          hmac('api:media:upload:account', 'account-1'),
          hmac('api:write:ip', '192.0.2.10'),
          hmac('api:write:account', 'account-1'),
        ]),
      );
    },
  );

  it.each([
    ['GET', '/media'],
    ['GET', '/media/some-id/file'],
    ['DELETE', '/media/some-id'],
    ['DELETE', '/users/me/avatar'],
    ['DELETE', '/communities/gardening/icon'],
    ['PUT', '/communities/gardening/rules'],
    ['PUT', '/communities/a/b/icon'],
  ])('does not treat %s %s as an upload', (method, path) => {
    expect(isMediaUpload(method, path)).toBe(false);
  });

  // Every account-email route sends an email; the confirmation route takes a
  // secret. Each counts per IP and per account or code.
  it.each([
    [
      'verify-request',
      (svc: AuthRateLimitService) =>
        svc.enforceEmailVerifyRequest('192.0.2.10', 'account-1'),
      ['email:verify-request:ip', '192.0.2.10'],
      ['email:verify-request:account', 'account-1'],
    ],
    [
      'verify',
      (svc: AuthRateLimitService) =>
        svc.enforceEmailVerify('192.0.2.10', 'the-code'),
      ['email:verify:ip', '192.0.2.10'],
      ['email:verify:token', 'the-code'],
    ],
    [
      'email change',
      (svc: AuthRateLimitService) =>
        svc.enforceEmailChange('192.0.2.10', 'account-1'),
      ['email:change:ip', '192.0.2.10'],
      ['email:change:account', 'account-1'],
    ],
    [
      'data export',
      (svc: AuthRateLimitService) =>
        svc.enforceDataExport('192.0.2.10', 'account-1'),
      ['data:export:ip', '192.0.2.10'],
      ['data:export:account', 'account-1'],
    ],
  ] as const)(
    'counts %s per IP and per account or code',
    async (_name, enforce, ipBucket, ownBucket) => {
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

      await enforce(service);

      const keys = calls
        .filter((call) => call.sql.startsWith('INSERT INTO auth_rate_limits'))
        .map((call) => call.values[0]);
      expect(keys).toEqual([
        hmac(ipBucket[0], ipBucket[1]),
        hmac(ownBucket[0], ownBucket[1]),
      ]);
    },
  );
});
