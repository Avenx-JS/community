import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';

interface RateLimitedRequest extends Request {
  user?: { id: string };
}

@Injectable()
export class ApiRateLimitInterceptor implements NestInterceptor {
  constructor(private readonly rateLimitService: AuthRateLimitService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<RateLimitedRequest>();
    const response = http.getResponse<Response>();
    const method = request.method.toUpperCase();
    const path = request.path;

    if (method === 'GET' && path === '/health') {
      return next.handle();
    }

    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const retryAfter = await this.rateLimitService.enforceApiRequest(
      ip,
      method,
      path,
      request.user?.id,
    );

    if (retryAfter !== null) {
      response.setHeader('Retry-After', retryAfter);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests',
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return next.handle();
  }
}
