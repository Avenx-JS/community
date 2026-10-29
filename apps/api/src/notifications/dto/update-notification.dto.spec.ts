import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { ReadAllNotificationsDto } from './read-all-notifications.dto';
import { UpdateNotificationDto } from './update-notification.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe('UpdateNotificationDto', () => {
  const transform = (body: unknown): Promise<unknown> =>
    pipe.transform(body, { type: 'body', metatype: UpdateNotificationDto });

  it.each([true, false])('accepts read: %s', async (read) => {
    await expect(transform({ read })).resolves.toEqual({ read });
  });

  it.each([
    ['a missing read', {}],
    ['a null read', { read: null }],
    ['a string read', { read: 'true' }],
    ['a numeric read', { read: 1 }],
    ['a client-supplied read_at', { read: true, read_at: '2026-01-01' }],
    ['a recipient', { read: true, recipient_id: 'user-b' }],
    ['an unknown property', { read: true, unexpected: 1 }],
  ])('rejects %s', async (_, body) => {
    await expect(transform(body)).rejects.toThrow();
  });
});

describe('ReadAllNotificationsDto', () => {
  it('accepts an empty body or query', async () => {
    for (const type of ['body', 'query'] as const) {
      await expect(
        pipe.transform({}, { type, metatype: ReadAllNotificationsDto }),
      ).resolves.toEqual({});
    }
  });

  it.each([
    { type: 'post_comment' },
    { community_id: 'community-1' },
    { recipient_id: 'user-b' },
    { read: false },
  ])('rejects any filter or field: %o', async (input) => {
    for (const type of ['body', 'query'] as const) {
      await expect(
        pipe.transform(input, { type, metatype: ReadAllNotificationsDto }),
      ).rejects.toThrow();
    }
  });
});
