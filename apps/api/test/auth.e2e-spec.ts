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
  user_id: string;
  expires_at: Date;
}

describe('Auth endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let users: TestUser[];
  let sessions: TestSession[];
  let pool: {
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };

  beforeEach(async () => {
    users = [];
    sessions = [];
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
      if (sql.startsWith('INSERT INTO auth_sessions')) {
        const [tokenHash, userId, expiresAt] = values as [string, string, Date];
        sessions.push({
          token_hash: tokenHash,
          user_id: userId,
          expires_at: expiresAt,
        });
        return Promise.resolve([{ affectedRows: 1 }, []]);
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
      if (sql.startsWith('DELETE FROM auth_sessions')) {
        const [tokenHash] = values as [string];
        sessions = sessions.filter((entry) => entry.token_hash !== tokenHash);
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };
    pool = { execute };

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
      user: Record<string, unknown>;
    };

    expect(body).toMatchObject({
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresAt: expect.any(String),
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
  });
});
