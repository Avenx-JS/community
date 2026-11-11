import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListCommentRepliesDto,
  ListCommentThreadDto,
} from './list-comment-replies.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe('ListCommentRepliesDto', () => {
  it.each([
    { page: '1', limit: '1', sort: 'oldest' },
    { page: '10000', limit: '100', sort: 'new' },
    { page: '1', limit: '20', sort: 'top' },
    { page: '1', limit: '20', sort: 'controversial' },
  ])('transforms values at their bounds: %o', async (query) => {
    const dto = plainToInstance(ListCommentRepliesDto, query);
    expect(dto).toMatchObject({
      page: Number(query.page),
      limit: Number(query.limit),
      sort: query.sort,
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  // sort is left unset and CommentsService applies oldest (and page 1,
  // limit 20); the service spec asserts those defaults.
  it('accepts an empty query', async () => {
    const dto = (await pipe.transform(
      {},
      { type: 'query', metatype: ListCommentRepliesDto },
    )) as ListCommentRepliesDto;
    expect(dto.sort).toBeUndefined();
    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([
    { page: '0' },
    { page: '10001' },
    { page: '1.5' },
    { page: 'one' },
    { limit: '0' },
    { limit: '101' },
    { limit: 'ten' },
    { sort: 'hot' },
    { sort: 'best' },
    { sort: 'TOP' },
    { sort: 'old' },
    { sort: 'created_at DESC' },
  ])('rejects %o', async (query) => {
    expect(
      await validate(plainToInstance(ListCommentRepliesDto, query)),
    ).not.toHaveLength(0);
  });

  it.each([{ depth: '2' }, { parent_id: 'x' }, { unexpected: 'value' }])(
    'rejects the unknown property %o under the global validation pipe',
    async (query) => {
      await expect(
        pipe.transform(query, {
          type: 'query',
          metatype: ListCommentRepliesDto,
        }),
      ).rejects.toThrow();
    },
  );
});

describe('ListCommentThreadDto', () => {
  const thread = (query: Record<string, unknown>) =>
    pipe.transform(query, { type: 'query', metatype: ListCommentThreadDto });

  it.each(['oldest', 'new', 'top', 'controversial'])(
    'accepts sort=%s',
    async (sort) => {
      await expect(thread({ sort })).resolves.toMatchObject({ sort });
    },
  );

  it('accepts an empty query, leaving the default to the service', async () => {
    await expect(thread({})).resolves.toEqual({});
  });

  // The tree is bounded, not paged.
  it.each([
    { sort: 'hot' },
    { page: '1' },
    { limit: '20' },
    { time: 'day' },
    { unexpected: 'value' },
  ])('rejects %o', async (query) => {
    await expect(thread(query)).rejects.toThrow();
  });
});
