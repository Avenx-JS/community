import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateOwnProfileDto } from './update-own-profile.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const transform = (body: unknown): Promise<unknown> =>
  pipe.transform(body, { type: 'body', metatype: UpdateOwnProfileDto });

const messages = async (body: unknown) => {
  const error = await transform(body).catch((rejection: unknown) => rejection);
  expect(error).toBeInstanceOf(BadRequestException);
  return ((error as BadRequestException).getResponse() as { message: string[] })
    .message;
};

describe('UpdateOwnProfileDto', () => {
  it.each([
    [{ display_name: ' Sam ' }, { display_name: 'Sam' }],
    [
      { bio: '  Grows tomatoes.\nAlso beans.  ' },
      { bio: 'Grows tomatoes.\nAlso beans.' },
    ],
    [
      { display_name: 'Sam', bio: 'Gardener' },
      { display_name: 'Sam', bio: 'Gardener' },
    ],
    // Trimmed to empty: the service stores NULL.
    [{ display_name: '   ' }, { display_name: '' }],
    [{ bio: '' }, { bio: '' }],
  ])('accepts and trims %o', async (body, expected) => {
    await expect(transform(body)).resolves.toEqual(expected);
  });

  it('accepts each field at its upper bound', async () => {
    await expect(
      transform({ display_name: 'a'.repeat(50), bio: 'b'.repeat(500) }),
    ).resolves.toEqual({ display_name: 'a'.repeat(50), bio: 'b'.repeat(500) });
  });

  it('rejects an empty body with a single message', async () => {
    await expect(messages({})).resolves.toEqual([
      'at least one of display_name or bio must be provided',
    ]);
  });

  it.each([
    [
      { display_name: 'a'.repeat(51) },
      'display_name must be shorter than or equal to 50 characters',
    ],
    [
      { bio: 'b'.repeat(501) },
      'bio must be shorter than or equal to 500 characters',
    ],
    [{ display_name: 42 }, 'display_name must be a string'],
    [{ bio: ['x'] }, 'bio must be a string'],
    // null is a value, not an absence; clearing is spelled "".
    [{ display_name: null }, 'display_name must be a string'],
    [{ bio: null }, 'bio must be a string'],
    [{ display_name: 'Sam\u0000' }, 'must not contain control characters'],
    [{ bio: 'Hi\u0007' }, 'must not contain control characters'],
    // A display name is single-line; a bio may wrap.
    [{ display_name: 'Sam\nSmith' }, 'must not contain control characters'],
  ])('rejects %o', async (body, message) => {
    await expect(messages(body)).resolves.toContain(message);
  });

  it('bounds the length after trimming', async () => {
    await expect(
      transform({ display_name: ` ${'a'.repeat(50)} ` }),
    ).resolves.toEqual({ display_name: 'a'.repeat(50) });
  });

  // The security boundary: these must never be settable through this DTO.
  it.each([
    'username',
    'email',
    'role',
    'id',
    'created_at',
    'password_hash',
    'last_seen_at',
    'at_least_one_field',
  ])('rejects %s, alone or beside a valid field', async (property) => {
    for (const body of [
      { [property]: 'x' },
      { display_name: 'Sam', [property]: 'x' },
    ]) {
      await expect(messages(body)).resolves.toContain(
        `property ${property} should not exist`,
      );
    }
  });
});
