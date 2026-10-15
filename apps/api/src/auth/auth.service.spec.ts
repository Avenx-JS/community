import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import { AuthService } from './auth.service';

type ExecuteFunction = (
  sql: string,
  values: unknown[],
) => Promise<[unknown, unknown]>;

describe('AuthService', () => {
  let service: AuthService;
  let execute: ExecuteFunction;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let results: Array<[unknown, unknown] | Error>;

  beforeEach(() => {
    calls = [];
    results = [];
    execute = (sql, values) => {
      calls.push({ sql, values });
      const result = results.shift();
      if (result instanceof Error) {
        return Promise.reject(result);
      }
      return Promise.resolve(result ?? [[], []]);
    };
    service = new AuthService({ execute } as unknown as Pool);
  });

  it('hashes passwords and stores only a hash of the access token', async () => {
    results.push([{ affectedRows: 1 }, []], [{ affectedRows: 1 }, []]);

    const response = await service.register({
      username: 'sample_user',
      email: 'sample@example.com',
      password: 'correct-horse-battery',
    });
    const insertedUserValues = calls[0].values;
    const insertedSessionValues = calls[1].values;
    const insertedPasswordHash = insertedUserValues[3] as string;
    const insertedTokenHash = insertedSessionValues[0] as string;

    expect(insertedPasswordHash).not.toBe('correct-horse-battery');
    expect(insertedPasswordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(insertedTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(insertedTokenHash).not.toBe(response.accessToken);
    expect(response).toMatchObject({ tokenType: 'Bearer' });
    expect(response.user).toEqual({
      id: expect.any(String),
      username: 'sample_user',
      email: 'sample@example.com',
      createdAt: expect.any(String),
    });
    expect(response.user).not.toHaveProperty('password');
    expect(response.user).not.toHaveProperty('password_hash');
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

  it('accepts a valid password on login and rejects invalid credentials', async () => {
    results.push([{ affectedRows: 1 }, []], [{ affectedRows: 1 }, []]);
    await service.register({
      username: 'sample_user',
      email: 'sample@example.com',
      password: 'correct-horse-battery',
    });
    const userValues = calls[0].values;
    const passwordHash = userValues[3] as string;
    const user = {
      id: '0123456789abcdef0123456789abcdef',
      username: 'sample_user',
      email: 'sample@example.com',
      password_hash: passwordHash,
      created_at: new Date(),
    };
    results.push([[user], []], [{ affectedRows: 1 }, []]);

    await expect(
      service.login({
        identifier: 'sample@example.com',
        password: 'correct-horse-battery',
      }),
    ).resolves.toMatchObject({ user: { id: user.id }, tokenType: 'Bearer' });

    results.push([[], []]);
    await expect(
      service.login({
        identifier: 'missing@example.com',
        password: 'correct-horse-battery',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('deletes the hashed access token on logout', async () => {
    results.push([{ affectedRows: 1 }, []]);

    await service.logout('opaque-access-token');

    expect(calls[0].sql).toBe('DELETE FROM auth_sessions WHERE token_hash = ?');
    expect(calls[0].values[0]).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  });
});
