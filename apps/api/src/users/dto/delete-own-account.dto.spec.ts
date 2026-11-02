import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DeleteOwnAccountDto } from './delete-own-account.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const transform = (body: unknown): Promise<unknown> =>
  pipe.transform(body, { type: 'body', metatype: DeleteOwnAccountDto });

const messages = async (body: unknown) => {
  const error = await transform(body).catch((rejection: unknown) => rejection);
  expect(error).toBeInstanceOf(BadRequestException);
  return ((error as BadRequestException).getResponse() as { message: string[] })
    .message;
};

describe('DeleteOwnAccountDto', () => {
  it.each(['a'.repeat(12), 'a'.repeat(128), ' correct horse battery '])(
    'accepts a password of login length, untrimmed: %j',
    async (password) => {
      await expect(transform({ password })).resolves.toEqual({ password });
    },
  );

  it.each([
    [{}, 'password must be a string'],
    [{ password: null }, 'password must be a string'],
    [{ password: 123456789012 }, 'password must be a string'],
    [
      { password: 'a'.repeat(11) },
      'password must be longer than or equal to 12 characters',
    ],
    [
      { password: 'a'.repeat(129) },
      'password must be shorter than or equal to 128 characters',
    ],
  ])('rejects %o', async (body, message) => {
    await expect(messages(body)).resolves.toContain(message);
  });

  it.each(['confirm', 'user_id', 'id', 'username'])(
    'rejects the unknown property %s',
    async (property) => {
      await expect(
        messages({ password: 'a'.repeat(12), [property]: 'x' }),
      ).resolves.toEqual([`property ${property} should not exist`]);
    },
  );
});
