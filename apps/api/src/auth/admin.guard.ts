import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UsersService } from '../users/users.service';
import type { PlatformRole } from '../users/users.service';
import type { AuthenticatedRequest } from './auth.guard';
import { REQUIRED_PLATFORM_ROLES } from './requires-role.decorator';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly usersService: UsersService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.id;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const requiredRoles = this.reflector.getAllAndOverride<PlatformRole[]>(
      REQUIRED_PLATFORM_ROLES,
      [context.getHandler(), context.getClass()],
    ) ?? ['admin'];
    const role = await this.usersService.getPlatformRole(userId);

    if (!role || !requiredRoles.includes(role)) {
      throw new ForbiddenException();
    }

    request.user = { id: userId, role };
    return true;
  }
}
