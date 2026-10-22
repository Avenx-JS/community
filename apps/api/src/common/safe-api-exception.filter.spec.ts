import { ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { SafeApiExceptionFilter } from './safe-api-exception.filter';

describe('SafeApiExceptionFilter', () => {
  const reply = jest.fn();
  const filter = new SafeApiExceptionFilter({
    httpAdapter: { reply },
  } as unknown as HttpAdapterHost);
  const loggerError = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  const response = {};
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        route: { path: '/auth/login' },
      }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  afterEach(() => {
    reply.mockClear();
    loggerError.mockClear();
  });

  it('returns generic 500 responses and logs only safe route context', () => {
    const error = new Error(
      'password=secret-password Authorization: Bearer secret-token',
    );

    filter.catch(error, host);

    expect(reply).toHaveBeenCalledWith(
      response,
      {
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
      },
      500,
    );
    expect(loggerError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).toContain('POST /auth/login');
    expect(logged).not.toContain('secret-password');
    expect(logged).not.toContain('secret-token');
  });

  it('preserves safe HTTP exceptions without logging them', () => {
    const exception = new HttpException('Invalid credentials', 401);

    filter.catch(exception, host);

    expect(reply).toHaveBeenCalledWith(response, 'Invalid credentials', 401);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('redacts server error details from HTTP exceptions', () => {
    const exception = new HttpException(
      'database password=secret-password',
      500,
    );

    filter.catch(exception, host);

    expect(reply).toHaveBeenCalledWith(
      response,
      {
        statusCode: 500,
        message: 'Internal server error',
        error: 'Internal Server Error',
      },
      500,
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      'secret-password',
    );
  });
});
