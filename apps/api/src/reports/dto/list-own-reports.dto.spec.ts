import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from '@jest/globals';
import { validate } from 'class-validator';
import { ListOwnReportsDto } from './list-own-reports.dto';

describe('ListOwnReportsDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const run = (query: object) =>
    pipe.transform(query, { type: 'query', metatype: ListOwnReportsDto });

  it('applies pagination and sort defaults', () => {
    expect(plainToInstance(ListOwnReportsDto, {})).toMatchObject({
      page: 1,
      limit: 20,
      sort: 'new',
    });
  });

  it('transforms and accepts every valid filter', async () => {
    const dto = plainToInstance(ListOwnReportsDto, {
      status: 'under_review',
      target_type: 'comment',
      page: '10000',
      limit: '100',
      sort: 'oldest',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto).toMatchObject({ page: 10000, limit: 100, sort: 'oldest' });
  });

  it.each(['open', 'under_review', 'resolved', 'rejected'])(
    'accepts status=%s',
    async (status) => {
      await expect(run({ status })).resolves.toBeInstanceOf(ListOwnReportsDto);
    },
  );

  it.each(['user', 'post', 'comment', 'community'])(
    'accepts target_type=%s',
    async (target_type) => {
      await expect(run({ target_type })).resolves.toBeInstanceOf(
        ListOwnReportsDto,
      );
    },
  );

  it.each([
    { page: '0' },
    { page: '10001' },
    { page: '1.5' },
    { limit: '0' },
    { limit: '101' },
    { status: 'withdrawn' },
    { target_type: 'POST' },
    { sort: 'random' },
    // A reporter parameter must not exist: the list is always the caller's own.
    { reporter_id: 'someone-else' },
    { reporter_username: 'someone_else' },
    { withdrawn: 'include' },
  ])('rejects %o', async (query) => {
    await expect(run(query)).rejects.toThrow();
  });
});
