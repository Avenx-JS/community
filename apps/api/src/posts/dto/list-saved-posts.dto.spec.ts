import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListSavedPostsDto } from './list-saved-posts.dto';

describe('ListSavedPostsDto', () => {
  it('transforms values at their bounds, and allows none', async () => {
    const dto = plainToInstance(ListSavedPostsDto, {
      page: '10000',
      limit: '100',
      sort: 'oldest',
    });
    expect(dto).toMatchObject({ page: 10000, limit: 100, sort: 'oldest' });
    expect(await validate(dto)).toHaveLength(0);
    expect(
      await validate(plainToInstance(ListSavedPostsDto, { sort: 'new' })),
    ).toHaveLength(0);
    expect(await validate(plainToInstance(ListSavedPostsDto, {}))).toHaveLength(
      0,
    );
  });

  it.each([
    { page: '0' },
    { page: '10001' },
    { page: '1.5' },
    { page: '1 OR 1=1' },
    { limit: '0' },
    { limit: '101' },
    { limit: 'ten' },
    { sort: 'top' },
    { sort: 'NEW' },
    { sort: 'created_at DESC' },
  ])('rejects %o', async (query) => {
    expect(
      await validate(plainToInstance(ListSavedPostsDto, query)),
    ).not.toHaveLength(0);
  });

  // No user parameter: the list is always the caller's own.
  it.each([
    { user_id: 'someone-else' },
    { username: 'someone' },
    { unexpected: 'value' },
  ])('rejects the unknown property %o under the global pipe', async (query) => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform(query, { type: 'query', metatype: ListSavedPostsDto }),
    ).rejects.toThrow();
  });
});
