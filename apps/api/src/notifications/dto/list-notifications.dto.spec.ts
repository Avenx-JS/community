import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { NOTIFICATION_TYPES } from '../notification-metadata';
import { ListNotificationsDto } from './list-notifications.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const transform = (input: Record<string, unknown>) =>
  pipe.transform(input, {
    type: 'query',
    metatype: ListNotificationsDto,
  }) as Promise<ListNotificationsDto>;

describe('ListNotificationsDto', () => {
  it('applies pagination and sort defaults and leaves filters unset', async () => {
    const dto = await transform({});

    expect(dto).toMatchObject({ page: 1, limit: 20, sort: 'new' });
    expect(dto.read).toBeUndefined();
    expect(dto.type).toBeUndefined();
    expect(dto.community_id).toBeUndefined();
  });

  it('transforms read=true and read=false into booleans', async () => {
    await expect(transform({ read: 'true' })).resolves.toMatchObject({
      read: true,
    });
    await expect(transform({ read: 'false' })).resolves.toMatchObject({
      read: false,
    });
  });

  it.each([...NOTIFICATION_TYPES])('accepts type %s', async (type) => {
    await expect(transform({ type })).resolves.toMatchObject({ type });
  });

  it('accepts valid community, bounds, and sort values', async () => {
    await expect(
      transform({
        community_id: 'a'.repeat(36),
        page: '10000',
        limit: '100',
        sort: 'oldest',
      }),
    ).resolves.toMatchObject({ page: 10000, limit: 100, sort: 'oldest' });
    await expect(
      transform({ community_id: 'Community_1-x', page: '1', limit: '1' }),
    ).resolves.toMatchObject({ community_id: 'Community_1-x' });
  });

  it.each([
    { read: 'yes' },
    { read: '1' },
    { read: '' },
    { type: 'vote' },
    { type: 'POST_COMMENT' },
    { community_id: '' },
    { community_id: 'a'.repeat(37) },
    { community_id: 'bad id' },
    { community_id: "x' OR '1'='1" },
    { page: '0' },
    { page: '10001' },
    { page: '1.5' },
    { page: 'one' },
    { limit: '0' },
    { limit: '101' },
    { sort: 'random' },
    { recipient_id: 'user-b' },
    { user_id: 'user-b' },
    { unexpected: 'value' },
  ])('rejects %o', async (input) => {
    await expect(transform(input)).rejects.toThrow();
  });
});
