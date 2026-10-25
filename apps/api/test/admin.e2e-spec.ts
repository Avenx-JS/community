import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  Controller,
  Get,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminAuthenticatedRequest } from '../src/auth/auth.guard';
import { AdminGuard } from '../src/auth/admin.guard';
import { AuthGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import { RequiresRole } from '../src/auth/requires-role.decorator';
import { UsersService } from '../src/users/users.service';
import type { PlatformRole } from '../src/users/users.service';

@Controller('admin-probe')
@UseGuards(AuthGuard, AdminGuard)
class AdminProbeController {
  @Get()
  probe(@Req() request: AdminAuthenticatedRequest) {
    return { role: request.user.role };
  }
}

@Controller('admin-moderator-probe')
@UseGuards(AuthGuard, AdminGuard)
class AdminModeratorProbeController {
  @Get()
  @RequiresRole('moderator')
  probe(@Req() request: AdminAuthenticatedRequest) {
    return { role: request.user.role };
  }
}

describe('Admin authorization pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let role: PlatformRole | null;
  let roleLookupError: Error | null;

  beforeEach(async () => {
    role = 'user';
    roleLookupError = null;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AdminProbeController, AdminModeratorProbeController],
      providers: [
        AuthGuard,
        AdminGuard,
        Reflector,
        {
          provide: AuthService,
          useValue: {
            validateAccessToken: (token: string) =>
              Promise.resolve(token === 'valid-token' ? 'test-user-id' : null),
          },
        },
        {
          provide: UsersService,
          useValue: {
            getPlatformRole: () =>
              roleLookupError
                ? Promise.reject(roleLookupError)
                : Promise.resolve(role),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
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

  it('returns 401 for missing, malformed, and invalid credentials', async () => {
    await request(app.getHttpServer()).get('/admin-probe').expect(401);
    await request(app.getHttpServer())
      .get('/admin-probe')
      .set('Authorization', 'Basic invalid')
      .expect(401);
    await request(app.getHttpServer())
      .get('/admin-probe')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
  });

  it('returns 403 for an authenticated user without admin role', async () => {
    await request(app.getHttpServer())
      .get('/admin-probe')
      .set('Authorization', 'Bearer valid-token')
      .expect(403);
  });

  it('allows an admin and exposes the database role to the controller', async () => {
    role = 'admin';

    const response = await request(app.getHttpServer())
      .get('/admin-probe')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(response.body).toEqual({ role: 'admin' });
  });

  it('denies moderators by default but honours explicit role requirements', async () => {
    role = 'moderator';

    await request(app.getHttpServer())
      .get('/admin-probe')
      .set('Authorization', 'Bearer valid-token')
      .expect(403);

    const response = await request(app.getHttpServer())
      .get('/admin-moderator-probe')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(response.body).toEqual({ role: 'moderator' });
  });

  it('masks role lookup failures as a generic 500', async () => {
    roleLookupError = new Error('database unavailable');

    const response = await request(app.getHttpServer())
      .get('/admin-probe')
      .set('Authorization', 'Bearer valid-token')
      .expect(500);

    expect(response.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      error: 'Internal Server Error',
    });
  });
});
