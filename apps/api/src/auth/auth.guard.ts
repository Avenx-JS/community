import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { PlatformRole } from '../users/users.service';
import { ALLOW_RESTRICTED } from './allow-restricted.decorator';
import { AuthService } from './auth.service';

export interface AuthenticatedRequest extends Request {
  user: { id: string; role?: PlatformRole };
  accessToken: string;
}

export interface AdminAuthenticatedRequest extends AuthenticatedRequest {
  user: { id: string; role: PlatformRole };
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector = new Reflector(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);

    if (!match) {
      throw new UnauthorizedException('Bearer token required');
    }

    const allowRestricted =
      this.reflector.getAllAndOverride<boolean>(ALLOW_RESTRICTED, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    const validation = await this.authService.validateAccessTokenState(match[1]);
    if (validation.kind === 'invalid') {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (validation.kind === 'restricted' && !allowRestricted) {
      throw new ForbiddenException(
        validation.restriction.type === 'suspension' &&
          validation.restriction.expires_at !== null
          ? {
              type: validation.restriction.type,
              expires_at: validation.restriction.expires_at,
            }
          : { type: validation.restriction.type },
      );
    }

    const userId =
      validation.kind === 'valid' || validation.kind === 'restricted'
        ? validation.userId
        : undefined;

    if (!userId) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    request.user = { id: userId };
    request.accessToken = match[1];
    return true;
  }
}

