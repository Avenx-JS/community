import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';

export interface OptionallyAuthenticatedRequest extends Request {
  user?: { id: string };
}

// For public reads whose response depends on who is asking (removed content
// is visible to its community's moderators and to platform admins). Never
// refuses: without a token, or with an invalid or expired one, the request
// proceeds anonymously, so these routes stay exactly as public as before. A
// valid token, including a restricted account's, identifies the viewer.
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<OptionallyAuthenticatedRequest>();
    const match = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      return true;
    }
    const validation = await this.authService.validateAccessTokenState(
      match[1],
    );
    if (validation.kind === 'valid' || validation.kind === 'restricted') {
      request.user = { id: validation.userId };
    }
    return true;
  }
}
