import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Reflector } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import type { PlatformRole } from '../users/users.service';
import type { AuthenticatedRequest } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { RequiresRole } from './requires-role.decorator';

@RequiresRole('moderator')
class RoleRequirementProbe {}

class EmptyController {}

describe('AdminGuard', () => {
  let guard: AdminGuard;
  let getPlatformRole: jest.Mock<UsersService['getPlatformRole']>;

  beforeEach(() => {
    getPlatformRole = jest.fn<UsersService['getPlatformRole']>();
    guard = new AdminGuard(
      { getPlatformRole } as unknown as UsersService,
      new Reflector(),
    );
  });

  function contextFor(
    user: AuthenticatedRequest['user'] | undefined,
    handler: () => void = () => undefined,
    controller: Type = EmptyController,
  ): ExecutionContextHost {
    const request = { user } as AuthenticatedRequest;
    return new ExecutionContextHost([request], controller, handler);
  }

  it('allows an admin by default and places the role on the request', async () => {
    getPlatformRole.mockResolvedValue('admin');
    const context = contextFor({ id: 'admin-id' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(getPlatformRole).toHaveBeenCalledWith('admin-id');
    expect(
      context.switchToHttp().getRequest<AuthenticatedRequest>().user,
    ).toEqual({
      id: 'admin-id',
      role: 'admin',
    });
  });

  it.each<PlatformRole>(['user', 'moderator'])(
    'denies %s when no role requirement is declared',
    async (role) => {
      getPlatformRole.mockResolvedValue(role);

      await expect(
        guard.canActivate(contextFor({ id: `${role}-id` })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('denies requests that did not run AuthGuard first', async () => {
    await expect(
      guard.canActivate(contextFor(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(getPlatformRole).not.toHaveBeenCalled();
  });

  it('denies unknown user ids', async () => {
    getPlatformRole.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextFor({ id: 'missing-id' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies unrecognised stored roles', async () => {
    getPlatformRole.mockResolvedValue('superadmin' as PlatformRole);

    await expect(
      guard.canActivate(contextFor({ id: 'user-id' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('propagates role lookup errors rather than granting or converting them to 403', async () => {
    const failure = new Error('database unavailable');
    getPlatformRole.mockRejectedValue(failure);

    await expect(
      guard.canActivate(contextFor({ id: 'admin-id' })),
    ).rejects.toBe(failure);
  });

  it('honours the explicit role metadata extension point', async () => {
    getPlatformRole.mockResolvedValue('moderator');

    await expect(
      guard.canActivate(
        contextFor({ id: 'moderator-id' }, RoleRequirementProbe),
      ),
    ).resolves.toBe(true);
  });
});
