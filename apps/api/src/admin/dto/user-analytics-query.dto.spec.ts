import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { resolveAnalyticsRange } from '../analytics-range';
import { UserAnalyticsQueryDto } from './user-analytics-query.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validateQuery = (query: Record<string, unknown>) =>
  pipe.transform(query, {
    type: 'query',
    metatype: UserAnalyticsQueryDto,
  }) as Promise<UserAnalyticsQueryDto>;

// The DTO validates each field; resolveAnalyticsRange applies the cross-field
// rules after defaults are known. Together they form the request contract.
const resolve = async (query: Record<string, unknown>, now: Date) =>
  resolveAnalyticsRange(await validateQuery(query), now);

describe('UserAnalyticsQueryDto', () => {
  const now = new Date('2026-10-23T09:14:02Z');

  it('defaults to day granularity and the last 30 days', async () => {
    const dto = await validateQuery({});
    expect(dto.granularity).toBe('day');
    expect(await resolve({}, now)).toEqual({
      from: new Date('2026-09-23T09:14:02Z'),
      to: now,
    });
  });

  it('accepts week granularity and explicit bounds', async () => {
    await expect(
      validateQuery({
        granularity: 'week',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01',
      }),
    ).resolves.toMatchObject({ granularity: 'week' });
  });

  it.each([
    { granularity: 'month' },
    { from: 'yesterday' },
    { to: '2026-13-01' },
    { from: '2026-02-30T00:00:00Z' },
    { unknown: '1' },
    { page: '1' },
  ])('rejects invalid query %o', async (query) => {
    await expect(validateQuery(query)).rejects.toThrow(BadRequestException);
  });

  it.each([
    { from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
    { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' },
    { from: '2025-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' },
  ])('rejects range %o', async (query) => {
    await expect(resolve(query, now)).rejects.toThrow(BadRequestException);
  });
});
