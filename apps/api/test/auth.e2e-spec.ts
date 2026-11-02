import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { verify as argon2Verify } from 'argon2';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import {
  CHANGE_PASSWORD_SQL,
  LOCK_PASSWORD_SQL,
  MYSQL_POOL,
} from '../src/auth/auth.service';
import {
  ANONYMISE_ACCOUNT_SQL,
  CREATED_COMMUNITY_SQL,
  DELETE_PRIVATE_STATE_SQL,
  LOCK_ACCOUNT_SQL,
} from '../src/users/account-deletion.service';

interface TestUser {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  created_at: Date;
  last_seen_at: Date | null;
  deleted_at?: Date | null;
}

function legacyScryptHash(password: string): Promise<string> {
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

// Applies the deleted_at predicate when, and only when, the query carries it.
const passesDeletedFilter = (sql: string, user: TestUser) =>
  !sql.includes('deleted_at IS NULL') || !user.deleted_at;

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
  let userInsertCount: number;
  let sessions: TestSession[];
  let refreshTokens: TestRefreshToken[];
  let rateLimitBuckets: Map<string, TestRateLimitBucket>;
  let restrictedUserIds: Set<string>;
  let previousPasswordChangeAccountMax: string | undefined;
  let previousLoginIpMax: string | undefined;
  let previousLoginIpWindow: string | undefined;
  let previousActivityWriteInterval: string | undefined;
  let activityUpdateAttempts: number;
  let activityUpdateWrites: number;
  let throwOnActivityUpdate: boolean;
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
    previousActivityWriteInterval =
      process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS;
    previousPasswordChangeAccountMax =
      process.env.AUTH_PASSWORD_CHANGE_ACCOUNT_MAX;
    process.env.AUTH_LOGIN_IP_MAX = '2';
    process.env.AUTH_PASSWORD_CHANGE_ACCOUNT_MAX = '3';
    process.env.AUTH_LOGIN_IP_WINDOW_SECONDS = '60';
    process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS = '300';
    activityUpdateAttempts = 0;
    activityUpdateWrites = 0;
    throwOnActivityUpdate = false;
    users = [];
    userInsertCount = 0;
    sessions = [];
    refreshTokens = [];
    rateLimitBuckets = new Map();
    restrictedUserIds = new Set();
    const execute = (
      sql: string,
      values: unknown[],
    ): Promise<[unknown, unknown]> => {
      if (sql.startsWith('INSERT INTO users')) {
        userInsertCount += 1;
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
          last_seen_at: null,
        });
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if (sql.startsWith('SELECT id, username, email, password_hash')) {
        const [identifier] = values as [string, string];
        return Promise.resolve([
          users.filter(
            (user) =>
              (user.email === identifier ||
                user.username.toLowerCase() === identifier) &&
              passesDeletedFilter(sql, user),
          ),
          [],
        ]);
      }
      if (
        sql.startsWith(
          'SELECT username, display_name, bio, created_at FROM users WHERE username',
        )
      ) {
        const [username] = values as [string];
        return Promise.resolve([
          users.filter((user) => user.username === username),
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
      if (sql.includes('SET last_seen_at = UTC_TIMESTAMP()')) {
        activityUpdateAttempts += 1;
        if (throwOnActivityUpdate) {
          return Promise.reject(new Error('Activity write unavailable'));
        }
        const [userId, intervalSeconds] = values as [string, number];
        const user = users.find((entry) => entry.id === userId);
        const cutoff = Date.now() - intervalSeconds * 1000;
        if (
          user &&
          (user.last_seen_at === null || user.last_seen_at.getTime() < cutoff)
        ) {
          user.last_seen_at = new Date();
          activityUpdateWrites += 1;
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        return Promise.resolve([{ affectedRows: 0 }, []]);
      }
      if (sql.startsWith('SELECT auth_sessions.user_id AS id')) {
        const [tokenHash] = values as [string];
        const session = sessions.find(
          (entry) =>
            entry.token_hash === tokenHash &&
            entry.expires_at.getTime() > Date.now(),
        );
        return Promise.resolve([
          session
            ? [
                {
                  id: session.user_id,
                  restriction_type: restrictedUserIds.has(session.user_id)
                    ? 'suspension'
                    : null,
                  restriction_expires_at: null,
                },
              ]
            : [],
          [],
        ]);
      }
      if (sql.startsWith('SELECT type, expires_at')) {
        return Promise.resolve([[], []]);
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
          users.filter(
            (entry) => entry.id === userId && passesDeletedFilter(sql, entry),
          ),
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
      if (sql.startsWith('SELECT type, expires_at')) {
        return Promise.resolve([[], []]);
      }
      // Password change, through the real AuthService.
      if (sql === LOCK_PASSWORD_SQL) {
        const [userId] = values as [string];
        return Promise.resolve([
          users
            .filter(
              (entry) => entry.id === userId && passesDeletedFilter(sql, entry),
            )
            .map(({ id, password_hash }) => ({ id, password_hash })),
          [],
        ]);
      }
      if (sql === CHANGE_PASSWORD_SQL) {
        const [passwordHash, userId, oldPasswordHash] = values as string[];
        const user = users.find(
          (entry) =>
            entry.id === userId && entry.password_hash === oldPasswordHash,
        );
        if (user) {
          user.password_hash = passwordHash;
        }
        return Promise.resolve([{ affectedRows: user ? 1 : 0 }, []]);
      }
      // Account deletion, through the real AccountDeletionService.
      if (sql === LOCK_ACCOUNT_SQL) {
        const [userId] = values as [string];
        return Promise.resolve([
          users
            .filter((entry) => entry.id === userId)
            .map((entry) => ({
              id: entry.id,
              password_hash: entry.password_hash,
              deleted_at: entry.deleted_at ?? null,
            })),
          [],
        ]);
      }
      if (sql === CREATED_COMMUNITY_SQL) {
        return Promise.resolve([[], []]);
      }
      if (sql === ANONYMISE_ACCOUNT_SQL) {
        const [username, email, passwordHash, userId] = values as string[];
        const user = users.find((entry) => entry.id === userId)!;
        Object.assign(user, {
          username,
          email,
          password_hash: passwordHash,
          last_seen_at: null,
          deleted_at: new Date(),
        });
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if ((DELETE_PRIVATE_STATE_SQL as readonly string[]).includes(sql)) {
        return Promise.resolve([{ affectedRows: 0 }, []]);
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
    if (previousPasswordChangeAccountMax === undefined) {
      delete process.env.AUTH_PASSWORD_CHANGE_ACCOUNT_MAX;
    } else {
      process.env.AUTH_PASSWORD_CHANGE_ACCOUNT_MAX =
        previousPasswordChangeAccountMax;
    }
    if (previousLoginIpWindow === undefined) {
      delete process.env.AUTH_LOGIN_IP_WINDOW_SECONDS;
    } else {
      process.env.AUTH_LOGIN_IP_WINDOW_SECONDS = previousLoginIpWindow;
    }
    if (previousActivityWriteInterval === undefined) {
      delete process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS;
    } else {
      process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS =
        previousActivityWriteInterval;
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

  it('updates activity once per interval for authenticated requests only', async () => {
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'activity_user',
        email: 'activity@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);
    const firstToken = (registration.body as { accessToken: string })
      .accessToken;
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        identifier: 'activity_user',
        password: 'correct-horse-battery',
      })
      .expect(200);
    const secondToken = (login.body as { accessToken: string }).accessToken;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${firstToken}`)
      .expect(204);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${secondToken}`)
      .expect(204);

    expect(activityUpdateAttempts).toBe(2);
    expect(activityUpdateWrites).toBe(1);
    expect(users[0].last_seen_at).toBeInstanceOf(Date);
  });

  it('does not attribute public profile requests or invalid tokens as activity', async () => {
    users.push({
      id: 'public-user',
      username: 'public_user',
      email: 'public@example.com',
      password_hash: 'unused',
      created_at: new Date(),
      last_seen_at: null,
    });

    await request(app.getHttpServer())
      .get('/users/public_user')
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({ username: 'public_user' }),
      );
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);

    expect(activityUpdateAttempts).toBe(0);
    expect(users[0].last_seen_at).toBeNull();
  });

  it('keeps an authenticated request successful when activity telemetry fails', async () => {
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'telemetry_user',
        email: 'telemetry@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);
    const accessToken = (registration.body as { accessToken: string })
      .accessToken;
    throwOnActivityUpdate = true;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    expect(activityUpdateAttempts).toBe(1);
    expect(users[0].last_seen_at).toBeNull();
  });

  it('rejects a role supplied during registration before inserting a user', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'privileged_user',
        email: 'privileged@example.com',
        password: 'correct-horse-battery',
        role: 'admin',
      })
      .expect(400);

    expect(userInsertCount).toBe(0);
    expect(users).toHaveLength(0);
  });

  it('rejects a role supplied during login', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        identifier: 'sample_user',
        password: 'correct-horse-battery',
        role: 'admin',
      })
      .expect(400);

    expect(userInsertCount).toBe(0);
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

  it('refuses login, refresh and every issued token after account deletion', async () => {
    const register = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'leaving_user',
        email: 'leaving@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);
    const registerBody = register.body as {
      accessToken: string;
      refreshToken: string;
    };
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: 'leaving_user', password: 'correct-horse-battery' })
      .expect(200);
    const loginBody = login.body as { accessToken: string };

    await request(app.getHttpServer())
      .delete('/users/me')
      .set('Authorization', `Bearer ${registerBody.accessToken}`)
      .send({ password: 'wrong-horse-battery' })
      .expect(401);
    expect(users[0].deleted_at ?? null).toBeNull();

    await request(app.getHttpServer())
      .delete('/users/me')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ password: 'correct-horse-battery' })
      .expect(204);
    expect(users[0]).toMatchObject({
      username: `deleted_${users[0].id}`,
      email: `deleted_${users[0].id}@invalid`,
      password_hash: 'deleted',
    });

    // Both sessions, including the one that did not make the request.
    for (const token of [registerBody.accessToken, loginBody.accessToken]) {
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    }
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: registerBody.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: 'leaving_user', password: 'correct-horse-battery' })
      .expect(401);
    expect(refreshTokens.every((token) => token.revoked_at !== null)).toBe(
      true,
    );
  });

  it('refuses login and refresh for a deleted account even if a credential matched', async () => {
    const register = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'ghost_user',
        email: 'ghost@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);
    const { refreshToken } = register.body as { refreshToken: string };
    // Deleted without revocation or anonymisation: only the predicate stands
    // between this row and a session.
    users[0].deleted_at = new Date();

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: 'ghost_user', password: 'correct-horse-battery' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });

  describe('POST /auth/password/change', () => {
    const CURRENT = 'correct-horse-battery';
    const NEXT = 'brand-new-horse-battery';
    const responses: string[] = [];

    const register = async (username = 'changing_user') => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ username, email: `${username}@example.com`, password: CURRENT })
        .expect(201);
      responses.push(response.text);
      return response.body as { accessToken: string; refreshToken: string };
    };
    const change = async (
      accessToken: string | undefined,
      body: object,
      expected: number,
    ) => {
      const pending = request(app.getHttpServer()).post(
        '/auth/password/change',
      );
      if (accessToken) {
        void pending.set('Authorization', `Bearer ${accessToken}`);
      }
      const response = await pending.send(body).expect(expected);
      responses.push(response.text);
      return response;
    };
    const login = async (password: string, expected: number) => {
      // This suite caps login at two per IP; these tests count changes, not
      // logins, so each login starts from empty buckets.
      rateLimitBuckets.clear();
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ identifier: 'changing_user', password })
        .expect(expected);
      responses.push(response.text);
      return response.body as { accessToken: string };
    };

    beforeEach(() => {
      responses.length = 0;
    });

    // No response, successful or not, may carry a password or a hash.
    afterEach(() => {
      const serialised = responses.join('\n');
      for (const secret of [CURRENT, NEXT, '$argon2id$', 'password_hash']) {
        expect(serialised).not.toContain(secret);
      }
      for (const user of users) {
        expect(serialised).not.toContain(user.password_hash);
      }
    });

    it('changes the password, revokes every session, and requires the new password', async () => {
      const first = await register();
      const second = await login(CURRENT, 200);
      const previousHash = users[0].password_hash;

      const response = await change(
        first.accessToken,
        { current_password: CURRENT, new_password: NEXT },
        204,
      );

      expect(response.text).toBe('');
      expect(users[0].password_hash).not.toBe(previousHash);
      expect(users[0].password_hash).toMatch(
        /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/,
      );
      // The caller's own credentials as well as the other session's.
      for (const token of [first.accessToken, second.accessToken]) {
        await request(app.getHttpServer())
          .post('/auth/logout')
          .set('Authorization', `Bearer ${token}`)
          .expect(401);
      }
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(401);
      expect(sessions).toEqual([]);
      expect(refreshTokens.every((token) => token.revoked_at !== null)).toBe(
        true,
      );

      await login(CURRENT, 401);
      await login(NEXT, 200);
    });

    it('returns 401 for a wrong current password and writes nothing', async () => {
      const { accessToken } = await register();
      const previousHash = users[0].password_hash;

      await change(
        accessToken,
        { current_password: 'wrong-horse-battery', new_password: NEXT },
        401,
      );

      expect(users[0].password_hash).toBe(previousHash);
      expect(sessions).toHaveLength(1);
      await login(CURRENT, 200);
    });

    it('returns 401 without a valid bearer token', async () => {
      await register();
      const previousHash = users[0].password_hash;
      const body = { current_password: CURRENT, new_password: NEXT };

      await change(undefined, body, 401);
      await change('not-a-real-token', body, 401);
      expect(users[0].password_hash).toBe(previousHash);
    });

    it.each([
      [
        'the same password',
        { current_password: CURRENT, new_password: CURRENT },
      ],
      ['a missing current_password', { new_password: NEXT }],
      ['a missing new_password', { current_password: CURRENT }],
      ['an empty body', {}],
      [
        'an 11-character new_password',
        { current_password: CURRENT, new_password: 'p'.repeat(11) },
      ],
      [
        'a 129-character new_password',
        { current_password: CURRENT, new_password: 'p'.repeat(129) },
      ],
      [
        'an 11-character current_password',
        { current_password: 'p'.repeat(11), new_password: NEXT },
      ],
      [
        'a 129-character current_password',
        { current_password: 'p'.repeat(129), new_password: NEXT },
      ],
      [
        'a non-string new_password',
        { current_password: CURRENT, new_password: 123456789012 },
      ],
      [
        'a non-string current_password',
        { current_password: [CURRENT], new_password: NEXT },
      ],
      [
        'an unknown property naming a user',
        {
          current_password: CURRENT,
          new_password: NEXT,
          user_id: 'other-user',
        },
      ],
    ])('returns 400 for %s and writes nothing', async (_case, body) => {
      const { accessToken } = await register();
      const previousHash = users[0].password_hash;

      await change(accessToken, body, 400);

      expect(users[0].password_hash).toBe(previousHash);
      expect(sessions).toHaveLength(1);
    });

    it('lets a suspended or banned account change its password', async () => {
      const { accessToken } = await register();
      restrictedUserIds.add(users[0].id);

      await change(
        accessToken,
        { current_password: CURRENT, new_password: NEXT },
        204,
      );

      await expect(argon2Verify(users[0].password_hash, NEXT)).resolves.toBe(
        true,
      );
      expect(sessions).toEqual([]);
    });

    it('accepts a legacy scrypt hash and stores Argon2id afterwards', async () => {
      const { accessToken } = await register();
      users[0].password_hash = await legacyScryptHash(CURRENT);

      await change(
        accessToken,
        { current_password: CURRENT, new_password: NEXT },
        204,
      );

      expect(users[0].password_hash).toMatch(/^\$argon2id\$/);
      await login(NEXT, 200);
    });

    it('lets exactly one of two concurrent changes succeed', async () => {
      const first = await register();
      const second = await login(CURRENT, 200);
      const attempts = [
        [first.accessToken, 'first-new-horse-battery'],
        [second.accessToken, 'second-new-horse-battery'],
      ];

      const results = await Promise.all(
        attempts.map(([token, password]) =>
          request(app.getHttpServer())
            .post('/auth/password/change')
            .set('Authorization', `Bearer ${token}`)
            .send({ current_password: CURRENT, new_password: password }),
        ),
      );
      responses.push(...results.map((response) => response.text));

      const statuses = results.map((response) => response.status);
      expect(statuses.filter((status) => status === 204)).toHaveLength(1);
      for (const status of statuses) {
        expect([204, 401, 409]).toContain(status);
      }
      // The stored hash is the winner's, never an unknown password.
      const winner = attempts[statuses.indexOf(204)][1];
      await login(winner, 200);
    });

    it('returns 429 with Retry-After once the account bucket is exhausted', async () => {
      const { accessToken } = await register();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await change(
          accessToken,
          { current_password: 'wrong-horse-battery', new_password: NEXT },
          401,
        );
      }

      const limited = await change(
        accessToken,
        { current_password: CURRENT, new_password: NEXT },
        429,
      );

      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect((limited.body as { message: string }).message).toBe(
        'Too many requests',
      );
      await login(CURRENT, 200);
    });
  });
});
