import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { argon2id, hash as argon2Hash, verify as argon2Verify } from 'argon2';
import { createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { AuthService } from './auth.service';

type ExecuteResult = [unknown, unknown] | Error;
type ExecuteFunction = (
  sql: string,
  values: unknown[],
) => Promise<[unknown, unknown]>;

function createLegacyScryptHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(
          `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`,
        );
      },
    );
  });
}

describe('AuthService', () => {
  let service: AuthService;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let results: ExecuteResult[];
  let transactions: { commits: number; rollbacks: number };
  let execute: ExecuteFunction;

  beforeEach(() => {
    calls = [];
    results = [];
    transactions = { commits: 0, rollbacks: 0 };
    execute = (sql, values) => {
      calls.push({ sql, values });
      const result = results.shift();
      if (result instanceof Error) {
        return Promise.reject(result);
      }
      return Promise.resolve(result ?? [[], []]);
    };
    const connection = {
      execute,
      beginTransaction: () => Promise.resolve(),
      commit: () => {
        transactions.commits += 1;
        return Promise.resolve();
      },
      rollback: () => {
        transactions.rollbacks += 1;
        return Promise.resolve();
      },
      release: () => undefined,
    };
    service = new AuthService({
      execute,
      getConnection: () => Promise.resolve(connection),
    } as unknown as Pool);
  });

  it('records last-seen with the configured conditional interval after validation', async () => {
    const previousInterval = process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS;
    process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS = '42';
    const configuredService = new AuthService({
      execute,
      getConnection: () => Promise.resolve({}),
    } as unknown as Pool);
    results.push([[{ id: 'user-1' }], []], [{ affectedRows: 1 }, []]);

    try {
      await expect(
        configuredService.validateAccessToken('valid-token'),
      ).resolves.toBe('user-1');
    } finally {
      if (previousInterval === undefined) {
        delete process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS;
      } else {
        process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS = previousInterval;
      }
    }

    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain('FROM auth_sessions');
    expect(calls[1].sql).toContain('SET last_seen_at = UTC_TIMESTAMP()');
    expect(calls[1].sql).toContain(
      'last_seen_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)',
    );
    expect(calls[1].values).toEqual(['user-1', 42]);
  });

  it('uses the five-minute default activity interval', async () => {
    const previousInterval = process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS;
    delete process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS;
    const defaultService = new AuthService({
      execute,
      getConnection: () => Promise.resolve({}),
    } as unknown as Pool);
    results.push([[{ id: 'user-1' }], []], [{ affectedRows: 1 }, []]);

    try {
      await expect(
        defaultService.validateAccessToken('valid-token'),
      ).resolves.toBe('user-1');
    } finally {
      if (previousInterval === undefined) {
        delete process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS;
      } else {
        process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS = previousInterval;
      }
    }

    expect(calls[1].values).toEqual(['user-1', 300]);
  });

  it('does not update activity for invalid tokens', async () => {
    results.push([[], []]);

    await expect(service.validateAccessToken('invalid-token')).resolves.toBe(
      null,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('FROM auth_sessions');
  });

  it('keeps valid token validation successful when activity telemetry fails', async () => {
    results.push(
      [[{ id: 'user-1' }], []],
      new Error('Telemetry database unavailable'),
    );

    await expect(service.validateAccessToken('valid-token')).resolves.toBe(
      'user-1',
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].sql).toContain('UPDATE users');
  });

  it('stores hashes for both opaque credentials and returns short-lived tokens', async () => {
    results.push(
      [{ affectedRows: 1 }, []],
      [{ affectedRows: 1 }, []],
      [{ affectedRows: 1 }, []],
    );

    const response = await service.register({
      username: 'sample_user',
      email: 'sample@example.com',
      password: 'correct-horse-battery',
    });

    const insertedPasswordHash = calls[0].values[3] as string;
    const insertedAccessHash = calls[1].values[0] as string;
    const insertedRefreshHash = calls[2].values[0] as string;
    expect(insertedPasswordHash).not.toBe('correct-horse-battery');
    expect(calls[0].sql).toBe(
      'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
    );
    expect(calls[0].sql).not.toContain('role');
    expect(insertedPasswordHash).toMatch(
      /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/,
    );
    await expect(
      argon2Verify(insertedPasswordHash, 'correct-horse-battery'),
    ).resolves.toBe(true);
    expect(JSON.stringify(calls)).not.toContain('correct-horse-battery');
    expect(insertedAccessHash).toMatch(/^[a-f0-9]{64}$/);
    expect(insertedRefreshHash).toMatch(/^[a-f0-9]{64}$/);
    expect(insertedAccessHash).not.toBe(response.accessToken);
    expect(insertedRefreshHash).not.toBe(response.refreshToken);
    expect(response.tokenType).toBe('Bearer');
    expect(
      new Date(response.expiresAt).getTime() - Date.now(),
    ).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(response.refreshTokenExpiresAt).toEqual(expect.any(String));
    expect(response.user).not.toHaveProperty('password_hash');
    expect(transactions.commits).toBe(1);
  });

  it('rehashes a valid legacy scrypt password after successful login', async () => {
    const password = 'legacy-correct-password';
    const legacyHash = await createLegacyScryptHash(password);
    const user = {
      id: 'user-legacy',
      username: 'legacy_user',
      email: 'legacy@example.com',
      password_hash: legacyHash,
      created_at: new Date('2026-10-22T08:00:00.000Z'),
    };
    results.push(
      [[user], []],
      [{ affectedRows: 1 }, []],
      [{ affectedRows: 1 }, []],
      [{ affectedRows: 1 }, []],
    );

    const response = await service.login({
      identifier: 'legacy@example.com',
      password,
    });

    const rehashCall = calls.find((call) =>
      call.sql.startsWith('UPDATE users SET password_hash'),
    );
    expect(rehashCall?.values[1]).toBe('user-legacy');
    expect(rehashCall?.values[2]).toBe(legacyHash);
    const upgradedHash = rehashCall?.values[0] as string;
    expect(upgradedHash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    await expect(argon2Verify(upgradedHash, password)).resolves.toBe(true);
    expect(response.user).not.toHaveProperty('password_hash');
    expect(JSON.stringify(response)).not.toContain(legacyHash);
    expect(transactions.commits).toBe(1);
  });

  it('rejects incorrect passwords and malformed stored hash formats generically', async () => {
    const argonHash = await argon2Hash('correct-password', {
      type: argon2id,
      version: 0x13,
      memoryCost: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    });
    const user = {
      id: 'user-1',
      username: 'sample_user',
      email: 'sample@example.com',
      password_hash: argonHash,
      created_at: new Date(),
    };
    results.push([[user], []]);
    await expect(
      service.login({ identifier: 'sample_user', password: 'wrong-password' }),
    ).rejects.toMatchObject({
      status: 401,
      message: 'Invalid credentials',
    });
    expect(calls).toHaveLength(1);

    results.push([
      [{ ...user, password_hash: 'argon2id$invalid$untrusted-parameters' }],
      [],
    ]);
    await expect(
      service.login({ identifier: 'sample_user', password: 'password' }),
    ).rejects.toMatchObject({
      status: 401,
      message: 'Invalid credentials',
    });
    expect(calls).toHaveLength(2);
    expect(transactions.commits).toBe(0);
  });

  it('maps unique username or email conflicts to 409', async () => {
    results.push(
      Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' }),
    );

    await expect(
      service.register({
        username: 'taken_user',
        email: 'taken@example.com',
        password: 'correct-horse-battery',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rotates refresh and access credentials atomically', async () => {
    const refreshToken = 'a'.repeat(43);
    const familyExpiresAt = new Date(Date.now() + 60_000);
    const user = {
      id: 'user-id',
      username: 'sample_user',
      email: 'sample@example.com',
      password_hash: 'stored-hash',
      created_at: new Date(),
    };
    results.push(
      [
        [
          {
            session_id: 'session-id',
            user_id: user.id,
            expires_at: familyExpiresAt,
            used_at: null,
            revoked_at: null,
          },
        ],
        [],
      ],
      [[user], []],
      [{ affectedRows: 1 }, []],
      [{ affectedRows: 1 }, []],
      [{ affectedRows: 1 }, []],
    );

    const response = await service.refresh(refreshToken);

    expect(response.accessToken).not.toBe(refreshToken);
    expect(response.refreshToken).not.toBe(refreshToken);
    expect(response.refreshTokenExpiresAt).toBe(familyExpiresAt.toISOString());
    expect(calls[0].sql).toContain('FOR UPDATE');
    expect(calls[0].values[0]).toBe(
      createHash('sha256').update(refreshToken).digest('hex'),
    );
    expect(calls[2].sql).toContain('SET used_at');
    expect(calls[3].sql).toContain('UPDATE auth_sessions');
    expect(calls[4].sql).toContain('INSERT INTO auth_refresh_tokens');
    expect(transactions.commits).toBe(1);
    expect(transactions.rollbacks).toBe(0);
  });

  it('revokes the session family when a rotated refresh token is reused', async () => {
    const refreshToken = 'b'.repeat(43);
    results.push(
      [
        [
          {
            session_id: 'session-id',
            user_id: 'user-id',
            expires_at: new Date(Date.now() + 60_000),
            used_at: new Date(),
            revoked_at: null,
          },
        ],
        [],
      ],
      [{ affectedRows: 1 }, []],
      [{ affectedRows: 1 }, []],
    );

    await expect(service.refresh(refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(calls[1].sql).toBe('DELETE FROM auth_sessions WHERE session_id = ?');
    expect(calls[2].sql).toContain('UPDATE auth_refresh_tokens');
    expect(transactions.commits).toBe(1);
    expect(transactions.rollbacks).toBe(0);
  });

  it('rejects unknown refresh tokens and rolls back the transaction', async () => {
    results.push([[], []]);

    await expect(service.refresh('c'.repeat(43))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(transactions.commits).toBe(0);
    expect(transactions.rollbacks).toBe(1);
  });

  it('revokes all access and refresh credentials for the requested account', async () => {
    results.push(
      [[], []],
      [{ affectedRows: 2 }, []],
      [{ affectedRows: 2 }, []],
    );

    await service.logoutAll('user-id');

    expect(calls[0].sql).toContain('auth_refresh_tokens');
    expect(calls[1].sql).toBe('DELETE FROM auth_sessions WHERE user_id = ?');
    expect(calls[2].sql).toContain('UPDATE auth_refresh_tokens');
    expect(transactions.commits).toBe(1);
  });
});
