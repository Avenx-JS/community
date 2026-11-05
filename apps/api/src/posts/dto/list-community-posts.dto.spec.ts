import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListCommunityPostsDto } from './list-community-posts.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe('ListCommunityPostsDto', () => {
  it('transforms values at their bounds, and allows none', async () => {
    const dto = plainToInstance(ListCommunityPostsDto, {
      page: '10000',
      limit: '100',
      sort: 'new',
    });
    expect(dto).toMatchObject({ page: 10000, limit: 100, sort: 'new' });
    expect(await validate(dto)).toHaveLength(0);
    expect(
      await validate(plainToInstance(ListCommunityPostsDto, {})),
    ).toHaveLength(0);
  });

  it.each([
    { page: '0' },
    { page: '10001' },
    { page: '1.5' },
    { limit: '0' },
    { limit: '101' },
    { limit: 'ten' },
    { sort: 'oldest' },
    { sort: 'created_at DESC' },
  ])('rejects %o', async (query) => {
    expect(
      await validate(plainToInstance(ListCommunityPostsDto, query)),
    ).not.toHaveLength(0);
  });

  // community_id would contradict the path; the global pipe refuses it.
  it.each([{ community_id: 'community-2' }, { unexpected: 'value' }])(
    'rejects %o under the global validation pipe',
    async (query) => {
      await expect(
        pipe.transform(query, {
          type: 'query',
          metatype: ListCommunityPostsDto,
        }),
      ).rejects.toThrow();
    },
  );
});
