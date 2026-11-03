import { describe, expect, it } from '@jest/globals';
import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { NoQueryParamsGuard } from './no-query-params.guard';

const contextWith = (query: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ query }) }),
  }) as unknown as ExecutionContext;

describe('NoQueryParamsGuard', () => {
  const guard = new NoQueryParamsGuard();

  it('allows a request without query parameters', () => {
    expect(guard.canActivate(contextWith({}))).toBe(true);
  });

  it.each([{ days: '30' }, { from: '2026-01-01' }, { '': '' }, { a: ['1'] }])(
    'rejects %o with 400',
    (query) => {
      expect(() => guard.canActivate(contextWith(query))).toThrow(
        BadRequestException,
      );
    },
  );
});
