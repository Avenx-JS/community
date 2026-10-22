import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { AuthController } from './auth.controller';
import type { AuthenticatedRequest } from './auth.guard';
import { AuthService } from './auth.service';
import type { AuthResponse } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let registerResponse: AuthResponse;
  let loginResponse: AuthResponse;
  let registerCalls: unknown[];
  let loginCalls: unknown[];
  let refreshCalls: string[];
  let logoutCalls: string[];
  let logoutAllCalls: string[];

  const authService = {
    register: (input: Parameters<AuthService['register']>[0]) => {
      registerCalls.push(input);
      return Promise.resolve(registerResponse);
    },
    login: (input: Parameters<AuthService['login']>[0]) => {
      loginCalls.push(input);
      return Promise.resolve(loginResponse);
    },
    refresh: (token: string) => {
      refreshCalls.push(token);
      return Promise.resolve(loginResponse);
    },
    logout: (token: string) => {
      logoutCalls.push(token);
      return Promise.resolve();
    },
    logoutAll: (userId: string) => {
      logoutAllCalls.push(userId);
      return Promise.resolve();
    },
  } satisfies Pick<
    AuthService,
    'register' | 'login' | 'refresh' | 'logout' | 'logoutAll'
  >;

  beforeEach(async () => {
    registerResponse = {
      accessToken: 'registration-token',
      tokenType: 'Bearer',
      expiresAt: new Date().toISOString(),
      refreshToken: 'registration-refresh-token',
      refreshTokenExpiresAt: new Date().toISOString(),
      user: {
        id: 'user-id',
        username: 'sample',
        email: 'sample@example.com',
        createdAt: new Date().toISOString(),
      },
    };
    loginResponse = { ...registerResponse, accessToken: 'login-token' };
    registerCalls = [];
    loginCalls = [];
    refreshCalls = [];
    logoutCalls = [];
    logoutAllCalls = [];

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('delegates registration and login to the auth service', async () => {
    const registration = {
      username: 'sample',
      email: 'sample@example.com',
      password: 'password',
    };
    const login = { identifier: 'sample@example.com', password: 'password' };
    await expect(controller.register(registration)).resolves.toEqual(
      registerResponse,
    );
    await expect(controller.login(login)).resolves.toEqual(loginResponse);
    expect(registerCalls).toEqual([registration]);
    expect(loginCalls).toEqual([login]);
  });

  it('logs out the bearer token authenticated by the guard', async () => {
    const request = {
      accessToken: 'current-session-token',
      user: { id: 'user-id' },
    } as AuthenticatedRequest;

    await controller.logout(request);

    expect(logoutCalls).toEqual(['current-session-token']);
  });

  it('rotates refresh tokens and revokes all user sessions on request', async () => {
    await expect(
      controller.refresh({ refreshToken: 'current-refresh-token' }),
    ).resolves.toEqual(loginResponse);

    const request = {
      accessToken: 'current-session-token',
      user: { id: 'user-id' },
    } as AuthenticatedRequest;
    await controller.logoutAll(request);

    expect(refreshCalls).toEqual(['current-refresh-token']);
    expect(logoutAllCalls).toEqual(['user-id']);
  });
});
