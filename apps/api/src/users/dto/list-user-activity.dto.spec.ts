import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListUserActivityDto,
  ListUserCommunitiesDto,
} from './list-user-activity.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe.each([
  ['ListUserActivityDto', ListUserActivityDto],
  ['ListUserCommunitiesDto', ListUserCommunitiesDto],
])('%s', (_name, Dto) => {
  it('transforms pagination values at their bounds, and allows none', async () => {
    const dto = plainToInstance(Dto, { page: '10000', limit: '100' });
    expect(dto.page).toBe(10000);
    expect(dto.limit).toBe(100);
    expect(await validate(dto)).toHaveLength(0);
    expect(await validate(plainToInstance(Dto, {}))).toHaveLength(0);
  });

  it.each([
    { page: '0' },
    { page: '10001' },
    { page: '1.5' },
    { page: '1 OR 1=1' },
    { limit: '0' },
    { limit: '101' },
    { limit: 'ten' },
  ])('rejects out-of-range or non-integer values: %o', async (query) => {
    expect(await validate(plainToInstance(Dto, query))).not.toHaveLength(0);
  });

  it.each([{ user_id: 'someone-else' }, { username: 'x' }, { email: 'x' }])(
    'rejects unknown properties under the global validation pipe: %o',
    async (query) => {
      await expect(
        pipe.transform(query, { type: 'query', metatype: Dto }),
      ).rejects.toThrow();
    },
  );
});

describe('ListUserActivityDto sort', () => {
  it.each(['new', 'oldest'])('accepts %s', async (sort) => {
    expect(
      await validate(plainToInstance(ListUserActivityDto, { sort })),
    ).toHaveLength(0);
  });

  it.each(['top', 'created_at DESC', 'NEW', ''])('rejects %p', async (sort) => {
    expect(
      await validate(plainToInstance(ListUserActivityDto, { sort })),
    ).not.toHaveLength(0);
  });
});

describe('ListUserCommunitiesDto', () => {
  // The order is always by name, so a recency order cannot be requested.
  it('has no sort', async () => {
    await expect(
      pipe.transform(
        { sort: 'new' },
        { type: 'query', metatype: ListUserCommunitiesDto },
      ),
    ).rejects.toThrow();
  });
});
