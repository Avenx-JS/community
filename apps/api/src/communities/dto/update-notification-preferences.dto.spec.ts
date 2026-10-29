import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { UpdateNotificationPreferencesDto } from './update-notification-preferences.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

function validate(body: unknown) {
  return pipe.transform(body, {
    type: 'body',
    metatype: UpdateNotificationPreferencesDto,
  });
}

describe('UpdateNotificationPreferencesDto', () => {
  it.each([true, false])('accepts new_posts: %s', async (value) => {
    await expect(validate({ new_posts: value })).resolves.toEqual({
      new_posts: value,
    });
  });

  it.each([
    {},
    { new_posts: null },
    { new_posts: 'false' },
    { new_posts: 0 },
    { new_posts: false, user_id: 'someone-else' },
    { new_posts: false, comment_replies: false },
  ])('rejects %o', async (body) => {
    await expect(validate(body)).rejects.toThrow();
  });
});
