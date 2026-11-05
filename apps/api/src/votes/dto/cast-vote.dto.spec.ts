import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { CastVoteDto } from './cast-vote.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: CastVoteDto });

describe('CastVoteDto', () => {
  it.each([1, -1])('accepts value %i', async (value) => {
    await expect(validate({ value })).resolves.toMatchObject({ value });
  });

  it.each([
    [{}, 'a missing value'],
    [{ value: null }, 'null'],
    [{ value: 0 }, '0'],
    [{ value: 2 }, '2'],
    [{ value: -2 }, '-2'],
    [{ value: '1' }, 'a numeric string'],
    [{ value: 1.5 }, 'a fraction'],
  ] as [object, string][])('rejects %o (%s)', async (body) => {
    await expect(validate(body)).rejects.toThrow();
  });

  it.each([
    { value: 1, target_type: 'post' },
    { value: 1, target_id: 'post-2' },
    { value: 1, user_id: 'user-2' },
  ])('rejects the unknown property in %o', async (body) => {
    await expect(validate(body)).rejects.toThrow();
  });
});
