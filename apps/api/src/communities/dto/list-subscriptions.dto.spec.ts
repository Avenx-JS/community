import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListSubscriptionsDto } from './list-subscriptions.dto';

describe('ListSubscriptionsDto', () => {
  it('transforms pagination values at their bounds', async () => {
    const dto = plainToInstance(ListSubscriptionsDto, {
      page: '10000',
      limit: '100',
    });

    expect(dto.page).toBe(10000);
    expect(dto.limit).toBe(100);
    expect(await validate(dto)).toHaveLength(0);
    expect(
      await validate(plainToInstance(ListSubscriptionsDto, {})),
    ).toHaveLength(0);
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
    const dto = plainToInstance(ListSubscriptionsDto, query);
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it.each([{ user_id: 'someone-else' }, { unexpected: 'value' }])(
    'rejects unknown properties under the global validation pipe: %o',
    async (query) => {
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      });

      await expect(
        pipe.transform(query, {
          type: 'query',
          metatype: ListSubscriptionsDto,
        }),
      ).rejects.toThrow();
    },
  );
});
