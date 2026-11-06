import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { ForgotPasswordDto } from './forgot-password.dto';
import { ResetPasswordDto } from './reset-password.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe('ForgotPasswordDto', () => {
  const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: ForgotPasswordDto });

  it('accepts an email', async () => {
    await expect(validate({ email: 'a@example.com' })).resolves.toEqual({
      email: 'a@example.com',
    });
  });

  const addressOf = (length: number) =>
    `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(length - 197)}.com`;

  // IsEmail caps an address at 254 characters, inside MaxLength(255).
  it('accepts an address of 254 characters, and refuses 255', async () => {
    expect(addressOf(254)).toHaveLength(254);
    await expect(validate({ email: addressOf(254) })).resolves.toBeInstanceOf(
      ForgotPasswordDto,
    );
    expect(addressOf(255)).toHaveLength(255);
    await expect(validate({ email: addressOf(255) })).rejects.toThrow();
  });

  it.each([
    [{}],
    [{ email: 'not-an-email' }],
    [{ email: 42 }],
    [{ email: `${'a'.repeat(250)}@example.com` }],
    [{ email: 'a@example.com', username: 'someone' }],
  ])('rejects %j', async (body) => {
    await expect(validate(body)).rejects.toThrow();
  });
});

describe('ResetPasswordDto', () => {
  const VALID = { token: 'a'.repeat(43), new_password: 'p'.repeat(12) };
  const validate = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: ResetPasswordDto });

  it.each([
    ['token', 1],
    ['token', 128],
    ['new_password', 12],
    ['new_password', 128],
  ])('accepts %s at %i characters', async (field, length) => {
    await expect(
      validate({ ...VALID, [field]: 'x'.repeat(length) }),
    ).resolves.toBeInstanceOf(ResetPasswordDto);
  });

  it('accepts a base64url token as issued', async () => {
    await expect(
      validate({ ...VALID, token: 'aZ09-_'.repeat(7) + 'a' }),
    ).resolves.toBeInstanceOf(ResetPasswordDto);
  });

  it.each([
    ['token', ''],
    ['token', 'x'.repeat(129)],
    ['token', 'bad\u0000token'],
    ['token', 42],
    ['new_password', 'p'.repeat(11)],
    ['new_password', 'p'.repeat(129)],
    ['new_password', 42],
  ])('rejects %s of %j', async (field, value) => {
    await expect(validate({ ...VALID, [field]: value })).rejects.toThrow();
  });

  it.each([
    [{ token: VALID.token }],
    [{ new_password: VALID.new_password }],
    [{ ...VALID, user_id: 'someone' }],
  ])('rejects the missing or unknown field in %j', async (body) => {
    await expect(validate(body)).rejects.toThrow();
  });
});
