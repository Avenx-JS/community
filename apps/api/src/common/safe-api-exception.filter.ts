import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

interface RequestContext {
  method: string;
  route: string;
}

function getRequestContext(request: unknown): RequestContext {
  if (typeof request !== 'object' || request === null) {
    return { method: 'UNKNOWN', route: 'unmatched-route' };
  }

  const method =
    'method' in request && typeof request.method === 'string'
      ? request.method
      : 'UNKNOWN';
  const route =
    'route' in request &&
    typeof request.route === 'object' &&
    request.route !== null &&
    'path' in request.route &&
    typeof request.route.path === 'string'
      ? request.route.path
      : 'unmatched-route';

  return { method, route };
}

@Catch()
export class SafeApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeApiExceptionFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request: unknown = http.getRequest<unknown>();
    const { method, route } = getRequestContext(request);
    const response = http.getResponse<unknown>();
    const adapter = this.adapterHost.httpAdapter;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) {
        this.logger.error(`HTTP ${status} on ${method} ${route}`);
        adapter.reply(
          response,
          {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            message: 'Internal server error',
            error: 'Internal Server Error',
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
        return;
      }
      adapter.reply(response, exception.getResponse(), status);
      return;
    }

    this.logger.error(`Unhandled API exception: ${method} ${route}`);
    adapter.reply(
      response,
      {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
        error: 'Internal Server Error',
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
