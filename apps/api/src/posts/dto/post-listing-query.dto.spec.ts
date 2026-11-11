import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { ListCommunityPostsDto } from './list-community-posts.dto';
import { ListFeedDto } from './list-feed.dto';
import { ListPostsDto } from './list-posts.dto';
import { POST_LIST_SORTS, POST_TOP_WINDOWS } from './post-listing-query.dto';

// Under the global pipe, as the routes really run.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe.each([
  ['GET /posts', ListPostsDto],
  ['GET /communities/:name/posts', ListCommunityPostsDto],
  ['GET /feed', ListFeedDto],
])('%s query', (_route, metatype) => {
  const parse = (query: Record<string, unknown>) =>
    pipe.transform(query, { type: 'query', metatype });

  it('leaves sort and time unset, for the service defaults', async () => {
    await expect(parse({})).resolves.toEqual({});
  });

  it.each(POST_LIST_SORTS)('accepts sort=%s', async (sort) => {
    await expect(parse({ sort })).resolves.toMatchObject({ sort });
  });

  it.each(POST_TOP_WINDOWS)('accepts sort=top&time=%s', async (time) => {
    await expect(
      parse({ sort: 'top', time, page: '2', limit: '50' }),
    ).resolves.toMatchObject({ sort: 'top', time, page: 2, limit: 50 });
  });

  // time ranks top only; anywhere else it would be silently ignored.
  it.each([
    { time: 'day' },
    { sort: 'new', time: 'day' },
    { sort: 'hot', time: 'week' },
    { sort: 'rising', time: 'all' },
  ])('refuses %o', async (query) => {
    await expect(parse(query)).rejects.toThrow();
  });

  it.each([
    { sort: 'best' },
    { sort: 'HOT' },
    { sort: 'controversial' },
    { sort: 'score DESC' },
    { sort: 'top', time: 'decade' },
    { sort: 'top', time: 'DAY' },
    { page: '0' },
    { page: '10001' },
    { limit: '0' },
    { limit: '101' },
    { subscribed: 'true' },
    { unexpected: 'value' },
  ])('refuses %o', async (query) => {
    await expect(parse(query)).rejects.toThrow();
  });
});

describe('the feed and community queries', () => {
  // The feed's subscriber is the token's user and a community listing's
  // community is its path: neither takes community_id.
  it.each([ListCommunityPostsDto, ListFeedDto])(
    '%p refuses community_id',
    async (metatype) => {
      await expect(
        pipe.transform(
          { community_id: 'community-2' },
          { type: 'query', metatype },
        ),
      ).rejects.toThrow();
    },
  );

  it('GET /posts accepts community_id with any sort', async () => {
    await expect(
      pipe.transform(
        { community_id: 'community-2', sort: 'rising' },
        { type: 'query', metatype: ListPostsDto },
      ),
    ).resolves.toMatchObject({ community_id: 'community-2', sort: 'rising' });
  });
});
