import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PlatformRole } from '../users/users.service';
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
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/);

    if (!match) {
      throw new UnauthorizedException('Bearer token required');
    }

    const userId = await this.authService.validateAccessToken(match[1]);
    if (!userId) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    request.user = { id: userId };
    request.accessToken = match[1];
    return true;
  }
}
