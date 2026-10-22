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

describe('Auth endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let users: TestUser[];
  let sessions: TestSession[];
  let refreshTokens: TestRefreshToken[];
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
    users = [];
    sessions = [];
    refreshTokens = [];
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
        email: 'sample@example.com',
      },
    });
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
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...registration, username: 'another_user' })
      .expect(409);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ ...registration, email: 'another@example.com' })
      .expect(409);
  });

  it('logs in with username or email and rejects invalid credentials', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'sample_user',
        email: 'sample@example.com',
        password: 'correct-horse-battery',
      })
      .expect(201);

    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: 'sample_user', password: 'correct-horse-battery' })
      .expect(200);
    const loginBody = loginResponse.body as { accessToken: string };
    expect(loginBody.accessToken).toEqual(expect.any(String));

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        identifier: 'sample@example.com',
        password: 'incorrect-password',
      })
      .expect(401);
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
});
