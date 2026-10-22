import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { AuthService } from './auth.service';

type ExecuteResult = [unknown, unknown] | Error;
type ExecuteFunction = (
  sql: string,
  values: unknown[],
) => Promise<[unknown, unknown]>;

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
    expect(insertedPasswordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
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
