import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AuthController } from './auth.controller';
import type { AuthenticatedRequest } from './auth.guard';
import { AuthRateLimitService } from './auth-rate-limit.service';
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
  let rateLimitCalls: Array<{ scope: string; values: string[] }>;
  let retryAfter: number | null;

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
  const rateLimitService = {
    enforceRegistration: (ip: string, username: string, email: string) => {
      rateLimitCalls.push({ scope: 'register', values: [ip, username, email] });
      return Promise.resolve(retryAfter);
    },
    enforceLogin: (ip: string, identifier: string) => {
      rateLimitCalls.push({ scope: 'login', values: [ip, identifier] });
      return Promise.resolve(retryAfter);
    },
    enforceRefresh: (ip: string, token: string) => {
      rateLimitCalls.push({ scope: 'refresh', values: [ip, token] });
      return Promise.resolve(retryAfter);
    },
  } satisfies Pick<
    AuthRateLimitService,
    'enforceRegistration' | 'enforceLogin' | 'enforceRefresh'
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
    rateLimitCalls = [];
    retryAfter = null;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: AuthRateLimitService, useValue: rateLimitService },
      ],
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
    const request = { ip: '192.0.2.1', socket: { remoteAddress: 'local' } };
    const response = { setHeader: jest.fn() };
    await expect(
      controller.register(registration, request as never, response as never),
    ).resolves.toEqual(registerResponse);
    await expect(
      controller.login(login, request as never, response as never),
    ).resolves.toEqual(loginResponse);
    expect(registerCalls).toEqual([registration]);
    expect(loginCalls).toEqual([login]);
    expect(rateLimitCalls).toEqual([
      {
        scope: 'register',
        values: ['192.0.2.1', 'sample', 'sample@example.com'],
      },
      { scope: 'login', values: ['192.0.2.1', 'sample@example.com'] },
    ]);
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
    const request = { ip: '192.0.2.1', socket: { remoteAddress: 'local' } };
    const response = { setHeader: jest.fn() };
    await expect(
      controller.refresh(
        { refreshToken: 'current-refresh-token' },
        request as never,
        response as never,
      ),
    ).resolves.toEqual(loginResponse);

    const authenticatedRequest = {
      accessToken: 'current-session-token',
      user: { id: 'user-id' },
    } as AuthenticatedRequest;
    await controller.logoutAll(authenticatedRequest);

    expect(refreshCalls).toEqual(['current-refresh-token']);
    expect(logoutAllCalls).toEqual(['user-id']);
  });

  it('sets Retry-After and rejects requests denied by the limiter', async () => {
    retryAfter = 60;
    const response = { setHeader: jest.fn() };
    await expect(
      controller.login(
        { identifier: 'sample@example.com', password: 'password' },
        { ip: '192.0.2.1', socket: { remoteAddress: 'local' } } as never,
        response as never,
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(loginCalls).toHaveLength(0);
  });
});
