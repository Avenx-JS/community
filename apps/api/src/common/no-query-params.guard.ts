import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

// For routes that take no query parameters at all, such as a public summary
// that must not grow an implicit time range: any parameter is a 400, the
// same answer the global ValidationPipe gives an unknown property elsewhere.
@Injectable()
export class NoQueryParamsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (Object.keys(request.query ?? {}).length > 0) {
      throw new BadRequestException('This route takes no query parameters');
    }
    return true;
  }
}
