import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { MYSQL_POOL } from '../src/auth/auth.service';

interface TestUser {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

interface TestSession {
  token_hash: string;
  session_id: string;
  user_id: string;
  expires_at: Date;
}

interface TestRefreshToken {
  token_hash: string;
  session_id: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

interface TestRateLimitBucket {
  requestCount: number;
  windowStartedAt: number;
  windowSeconds: number;
}

describe('Auth endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let users: TestUser[];
  let sessions: TestSession[];
  let refreshTokens: TestRefreshToken[];
  let rateLimitBuckets: Map<string, TestRateLimitBucket>;
  let previousLoginIpMax: string | undefined;
  let previousLoginIpWindow: string | undefined;
  let pool: {
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
    getConnection: () => Promise<{
      execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
      beginTransaction: () => Promise<void>;
      commit: () => Promise<void>;
      rollback: () => Promise<void>;
      release: () => void;
    }>;
  };

  beforeEach(async () => {
    previousLoginIpMax = process.env.AUTH_LOGIN_IP_MAX;
    previousLoginIpWindow = process.env.AUTH_LOGIN_IP_WINDOW_SECONDS;
    process.env.AUTH_LOGIN_IP_MAX = '2';
    process.env.AUTH_LOGIN_IP_WINDOW_SECONDS = '60';
    users = [];
    sessions = [];
    refreshTokens = [];
    rateLimitBuckets = new Map();
    const execute = (
      sql: string,
      values: unknown[],
    ): Promise<[unknown, unknown]> => {
      if (sql.startsWith('INSERT INTO users')) {
        const [id, username, email, passwordHash] = values as [
          string,
          string,
          string,
          string,
        ];
        if (
          users.some(
            (user) =>
              user.username.toLowerCase() === username.toLowerCase() ||
              user.email === email,
          )
        ) {
          return Promise.reject(
            Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' }),
          );
        }
        users.push({
          id,
          username,
          email,
          password_hash: passwordHash,
          created_at: new Date(),
        });
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if (sql.startsWith('SELECT id, username, email, password_hash')) {
        const [identifier] = values as [string, string];
        return Promise.resolve([
          users.filter(
            (user) =>
              user.email === identifier ||
              user.username.toLowerCase() === identifier,
          ),
          [],
        ]);
      }
      if (sql.startsWith('UPDATE users SET password_hash')) {
        const [passwordHash, userId, oldPasswordHash] = values as [
          string,
          string,
          string,
        ];
        const user = users.find(
          (entry) =>
            entry.id === userId && entry.password_hash === oldPasswordHash,
        );
        if (user) {
          user.password_hash = passwordHash;
        }
        return Promise.resolve([{ affectedRows: user ? 1 : 0 }, []]);
      }
      if (sql.startsWith('SELECT user_id AS id FROM auth_sessions')) {
        const [tokenHash] = values as [string];
        const session = sessions.find(
          (entry) =>
            entry.token_hash === tokenHash &&
            entry.expires_at.getTime() > Date.now(),
        );
        return Promise.resolve([session ? [{ id: session.user_id }] : [], []]);
      }
      if (sql.startsWith('SELECT session_id FROM auth_sessions')) {
        const [tokenHash] = values as [string];
        const session = sessions.find(
          (entry) => entry.token_hash === tokenHash,
        );
        return Promise.resolve([
          session ? [{ session_id: session.session_id }] : [],
          [],
        ]);
      }
      if (sql.startsWith('INSERT INTO auth_rate_limits')) {
        const [bucketKey] = values as [string];
        const match = sql.match(/INTERVAL (\d+) SECOND/);
        if (!match) {
          return Promise.reject(new Error('Missing rate-limit window'));
        }
        const windowSeconds = Number(match[1]);
        const now = Date.now();
        const bucket = rateLimitBuckets.get(bucketKey);
        if (!bucket || bucket.windowStartedAt <= now - windowSeconds * 1000) {
          rateLimitBuckets.set(bucketKey, {
            requestCount: 1,
            windowStartedAt: now,
            windowSeconds,
          });
        } else {
          bucket.requestCount += 1;
        }
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if (sql.startsWith('SELECT request_count')) {
        const [bucketKey] = values as [string];
        const bucket = rateLimitBuckets.get(bucketKey);
        if (!bucket) {
          return Promise.resolve([[], []]);
        }
        const elapsedSeconds = Math.floor(
          (Date.now() - bucket.windowStartedAt) / 1000,
        );
        return Promise.resolve([
          [
            {
              request_count: bucket.requestCount,
              retry_after: Math.max(1, bucket.windowSeconds - elapsedSeconds),
            },
          ],
          [],
        ]);
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };
    const connectionExecute = (
      sql: string,
      values: unknown[],
    ): Promise<[unknown, unknown]> => {
      if (sql.startsWith('INSERT INTO auth_sessions')) {
        const [tokenHash, userId, expiresAt, sessionId] = values as [
          string,
          string,
          Date,
          string,
        ];
        sessions.push({
          token_hash: tokenHash,
          session_id: sessionId,
          user_id: userId,
          expires_at: expiresAt,
        });
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if (sql.startsWith('INSERT INTO auth_refresh_tokens')) {
        const [tokenHash, sessionId, userId, expiresAt] = values as [
          string,
          string,
          string,
          Date,
        ];
        refreshTokens.push({
          token_hash: tokenHash,
          session_id: sessionId,
          user_id: userId,
          expires_at: expiresAt,
          used_at: null,
          revoked_at: null,
        });
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if (sql.startsWith('SELECT session_id, user_id, expires_at')) {
        const [tokenHash] = values as [string];
        const token = refreshTokens.find(
          (entry) => entry.token_hash === tokenHash,
        );
        return Promise.resolve([token ? [token] : [], []]);
      }
      if (sql.startsWith('SELECT id, username, email, password_hash')) {
        const [userId] = values as [string];
        return Promise.resolve([
          users.filter((entry) => entry.id === userId),
          [],
        ]);
      }
      if (sql.startsWith('UPDATE auth_refresh_tokens SET used_at')) {
        const [tokenHash] = values as [string];
        const token = refreshTokens.find(
          (entry) => entry.token_hash === tokenHash && entry.used_at === null,
        );
        if (token) {
          token.used_at = new Date();
        }
        return Promise.resolve([{ affectedRows: token ? 1 : 0 }, []]);
      }
      if (sql.startsWith('UPDATE auth_sessions SET token_hash')) {
        const [tokenHash, expiresAt, sessionId] = values as [
          string,
          Date,
          string,
        ];
        const session = sessions.find(
          (entry) => entry.session_id === sessionId,
        );
        if (session) {
          session.token_hash = tokenHash;
          session.expires_at = expiresAt;
        }
        return Promise.resolve([{ affectedRows: session ? 1 : 0 }, []]);
      }
      if (sql.startsWith('DELETE FROM auth_sessions WHERE session_id')) {
        const [sessionId] = values as [string];
        const previousLength = sessions.length;
        sessions = sessions.filter((entry) => entry.session_id !== sessionId);
        return Promise.resolve([
          { affectedRows: previousLength - sessions.length },
          [],
        ]);
      }
      if (sql.startsWith('DELETE FROM auth_sessions WHERE user_id')) {
        const [userId] = values as [string];
        const previousLength = sessions.length;
        sessions = sessions.filter((entry) => entry.user_id !== userId);
        return Promise.resolve([
          { affectedRows: previousLength - sessions.length },
          [],
        ]);
      }
      if (sql.startsWith('UPDATE auth_refresh_tokens SET revoked_at')) {
        const [id] = values as [string];
        const isUserQuery = sql.includes('WHERE user_id = ?');
        const affected = refreshTokens.filter((entry) => {
          const matches = isUserQuery
            ? entry.user_id === id
            : entry.session_id === id;
          if (matches && entry.revoked_at === null) {
            entry.revoked_at = new Date();
            return true;
          }
          return false;
        }).length;
        return Promise.resolve([{ affectedRows: affected }, []]);
      }
      if (sql.startsWith('SELECT token_hash FROM auth_refresh_tokens')) {
        return Promise.resolve([[], []]);
      }
      return Promise.reject(new Error(`Unexpected transactional SQL: ${sql}`));
    };
    pool = {
      execute,
      getConnection: () =>
        Promise.resolve({
          execute: connectionExecute,
          beginTransaction: () => Promise.resolve(),
          commit: () => Promise.resolve(),
          rollback: () => Promise.resolve(),
          release: () => undefined,
        }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue(pool)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    if (previousLoginIpMax === undefined) {
      delete process.env.AUTH_LOGIN_IP_MAX;
    } else {
      process.env.AUTH_LOGIN_IP_MAX = previousLoginIpMax;
    }
    if (previousLoginIpWindow === undefined) {
      delete process.env.AUTH_LOGIN_IP_WINDOW_SECONDS;
    } else {
      process.env.AUTH_LOGIN_IP_WINDOW_SECONDS = previousLoginIpWindow;
    }
  });

  it('registers a user and returns a bearer credential without password data', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'sample_user',
        email: 'SAMPLE@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);
    const body = response.body as {
      accessToken: string;
      tokenType: string;
      expiresAt: string;
      refreshToken: string;
      refreshTokenExpiresAt: string;
      user: Record<string, unknown>;
    };

    expect(body).toMatchObject({
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresAt: expect.any(String),
      refreshToken: expect.any(String),
      refreshTokenExpiresAt: expect.any(String),
      user: {
        id: expect.any(String),
        username: 'sample_user',
      },
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        'accessToken',
        'expiresAt',
        'refreshToken',
        'refreshTokenExpiresAt',
        'tokenType',
        'user',
      ].sort(),
    );
    expect(Object.keys(body.user).sort()).toEqual(['id', 'username']);
    expect(body).not.toHaveProperty('email');
    expect(body.user).not.toHaveProperty('password');
    expect(body.user).not.toHaveProperty('password_hash');
    expect(users[0].password_hash).not.toBe('correct-horse-battery');
  });

  it('rejects invalid input and duplicate username or email', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ username: 'x', email: 'not-an-email', password: 'short' })
      .expect(400);

    const registration = {
      username: 'sample_user',
      email: 'sample@example.com',
      password: 'correct-horse-battery',
    };
    await request(app.getHttpServer())
      .post('/auth/register')
      .send(registration)
      .expect(201);
    const duplicateUsername = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...registration, username: 'another_user' })
      .expect(409);
    const duplicateEmail = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...registration, email: 'another@example.com' })
      .expect(409);
    expect(duplicateUsername.body).toEqual(duplicateEmail.body);
    expect(JSON.stringify(duplicateUsername.body)).not.toContain(
      'sample@example.com',
    );
  });

  it('returns the same generic error for unknown accounts and incorrect passwords', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'sample_user',
        email: 'sample@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);

    const wrongPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        identifier: 'sample@example.com',
        password: 'incorrect-password',
      })
      .expect(401);
    const unknownUser = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        identifier: 'unknown@example.com',
        password: 'incorrect-password',
      })
      .expect(401);
    expect(unknownUser.body).toEqual(wrongPassword.body);
    expect(JSON.stringify(wrongPassword.body)).not.toContain(
      'incorrect-password',
    );
    expect(JSON.stringify(wrongPassword.body)).not.toContain(
      'sample@example.com',
    );
    expect(JSON.stringify(unknownUser.body)).not.toContain(
      'incorrect-password',
    );
  });

  it('invalidates the current bearer credential on logout', async () => {
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'sample_user',
        email: 'sample@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);
    const registrationBody = registration.body as { accessToken: string };
    const authorization = `Bearer ${registrationBody.accessToken}`;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', authorization)
      .expect(204);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', authorization)
      .expect(401);
    expect(refreshTokens[0].revoked_at).not.toBeNull();
  });

  it('rotates access and refresh credentials and rejects the old access token', async () => {
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'sample_user',
        email: 'sample@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);
    const original = registration.body as {
      accessToken: string;
      refreshToken: string;
    };

    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: original.refreshToken })
      .expect(200);
    const rotatedBody = rotated.body as {
      accessToken: string;
      refreshToken: string;
    };
    expect(rotatedBody.accessToken).not.toBe(original.accessToken);
    expect(rotatedBody.refreshToken).not.toBe(original.refreshToken);
    expect(refreshTokens[0].used_at).not.toBeNull();

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${original.accessToken}`)
      .expect(401);
  });

  it('revokes a token family when an old refresh token is replayed', async () => {
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'sample_user',
        email: 'sample@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);
    const original = registration.body as {
      accessToken: string;
      refreshToken: string;
    };
    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: original.refreshToken })
      .expect(200);
    const rotatedBody = rotated.body as {
      accessToken: string;
      refreshToken: string;
    };

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: original.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: rotatedBody.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${rotatedBody.accessToken}`)
      .expect(401);
    expect(refreshTokens.every((token) => token.revoked_at !== null)).toBe(
      true,
    );
  });

  it('rejects expired refresh tokens', async () => {
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'sample_user',
        email: 'sample@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);
    const registrationBody = registration.body as { refreshToken: string };
    refreshTokens[0].expires_at = new Date(Date.now() - 1000);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: registrationBody.refreshToken })
      .expect(401);
  });

  it('revokes every user session on logout-all', async () => {
    const register = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'sample_user',
        email: 'sample@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);
    const registerBody = register.body as { accessToken: string };
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        identifier: 'sample_user',
        password: 'correct-horse-battery',
      })
      .expect(200);
    const loginBody = login.body as { accessToken: string };
    expect(login.body).not.toHaveProperty('user.email');
    expect(login.body).not.toHaveProperty('user.createdAt');
    expect(login.body).not.toHaveProperty('user.password_hash');

    await request(app.getHttpServer())
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${registerBody.accessToken}`)
      .expect(204);

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(401);
    expect(refreshTokens.every((token) => token.revoked_at !== null)).toBe(
      true,
    );
  });

  it('returns 429 with Retry-After and ignores untrusted forwarded IP headers', async () => {
    for (const forwardedIp of ['198.51.100.1', '198.51.100.2']) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', forwardedIp)
        .send({
          identifier: 'unknown@example.com',
          password: 'incorrect-password',
        })
        .expect(401);
    }

    const limited = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', '198.51.100.3')
      .send({
        identifier: 'unknown@example.com',
        password: 'incorrect-password',
      })
      .expect(429);

    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const responseBody = limited.body as { message: string };
    expect(responseBody.message).toBe('Too many requests');

    for (const bucket of rateLimitBuckets.values()) {
      bucket.windowStartedAt = Date.now() - (bucket.windowSeconds + 1) * 1000;
    }
    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', '198.51.100.4')
      .send({
        identifier: 'unknown@example.com',
        password: 'incorrect-password',
      })
      .expect(401);
  });
});
