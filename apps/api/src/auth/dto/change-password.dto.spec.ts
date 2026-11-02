import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChangePasswordDto } from './change-password.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validateBody = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: ChangePasswordDto });

const VALID = {
  current_password: 'current-horse-battery',
  new_password: 'next-horse-battery-staple',
};

async function messages(body: unknown): Promise<string[]> {
  try {
    await validateBody(body);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    return response.message;
  }
}

describe('ChangePasswordDto', () => {
  it('accepts two different passwords within bounds', async () => {
    await expect(validateBody(VALID)).resolves.toEqual(VALID);
  });

  it.each([
    ['current_password', 12],
    ['current_password', 128],
    ['new_password', 12],
    ['new_password', 128],
  ])('accepts %s at the %i-character bound', async (field, length) => {
    await expect(
      validateBody({ ...VALID, [field]: 'p'.repeat(length) }),
    ).resolves.toBeInstanceOf(ChangePasswordDto);
  });

  it.each([
    ['current_password', 11],
    ['current_password', 129],
    ['new_password', 11],
    ['new_password', 129],
  ])('rejects %s of %i characters', async (field, length) => {
    expect(
      await messages({ ...VALID, [field]: 'p'.repeat(length) }),
    ).toContainEqual(expect.stringMatching(new RegExp(`^${field} must be`)));
  });

  it.each([
    ['current_password', undefined],
    ['new_password', undefined],
    ['current_password', 123456789012],
    ['new_password', ['next-horse-battery-staple']],
    ['new_password', null],
  ])('rejects a missing or non-string %s (%j)', async (field, value) => {
    expect(await messages({ ...VALID, [field]: value })).toContain(
      `${field} must be a string`,
    );
  });

  it('rejects a new password equal to the current one', async () => {
    expect(
      await messages({
        current_password: VALID.current_password,
        new_password: VALID.current_password,
      }),
    ).toEqual(['new_password must differ from current_password']);
  });

  it('runs the same-password rule as a cross-field constraint', async () => {
    const errors = await validate(
      plainToInstance(ChangePasswordDto, {
        current_password: 'same-horse-battery',
        new_password: 'same-horse-battery',
      }),
    );

    expect(errors.map((error) => error.property)).toEqual(['new_password']);
    expect(errors[0].constraints).toHaveProperty(
      'newPasswordDiffersFromCurrent',
    );
  });

  it.each(['user_id', 'id', 'userId', 'password'])(
    'rejects the unknown property %s',
    async (property) => {
      expect(await messages({ ...VALID, [property]: 'other-user' })).toContain(
        `property ${property} should not exist`,
      );
    },
  );
});
