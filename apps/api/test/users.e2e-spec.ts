import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { MYSQL_POOL } from '../src/auth/auth.service';

describe('User profile endpoint (e2e)', () => {
  let app: INestApplication<App>;
  const user = {
    id: 'user-id',
    username: 'sample_user',
    email: 'private@example.com',
    password_hash: 'private-hash',
    created_at: new Date('2026-10-21T20:00:00.000Z'),
  };
  let queryCalls: Array<{ sql: string; values: unknown[] }>;

  beforeEach(async () => {
    queryCalls = [];
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        queryCalls.push({ sql, values });
        const users = values[0] === user.username ? [user] : [];
        return Promise.resolve([users, []]);
      },
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

  it('returns the public profile without email or password data', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/sample_user')
      .expect(200);

    expect(response.body).toEqual({
      id: 'user-id',
      username: 'sample_user',
      created_at: '2026-10-21T20:00:00.000Z',
    });
    expect(response.body).not.toHaveProperty('email');
    expect(response.body).not.toHaveProperty('password');
    expect(response.body).not.toHaveProperty('password_hash');
    expect(queryCalls).toEqual([
      {
        sql: 'SELECT id, username, created_at FROM users WHERE username = ? LIMIT 1',
        values: ['sample_user'],
      },
    ]);
  });

  it('returns 404 when the username does not exist', async () => {
    const response = await request(app.getHttpServer())
      .get('/users/unknown')
      .expect(404);

    expect(response.body).toMatchObject({
      statusCode: 404,
      message: 'User not found',
      error: 'Not Found',
    });
  });
});
