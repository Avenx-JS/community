import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import {
  AssignUserFlairDto,
  CreateFlairDto,
  UpdateFlairDto,
} from './community-flairs.dto';
import { CreateJoinRequestDto } from './community-join-requests.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (metatype: new () => object, body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype });

describe('CreateFlairDto', () => {
  it('trims the text and lower-cases the colour', async () => {
    await expect(
      validate(CreateFlairDto, {
        kind: 'post',
        text: '  News ',
        background_color: '#FF4500',
        mod_only: true,
      }),
    ).resolves.toMatchObject({
      kind: 'post',
      text: 'News',
      background_color: '#ff4500',
      mod_only: true,
    });
  });

  it.each([
    { kind: 'comment', text: 'x' },
    { kind: 'post', text: '' },
    { kind: 'post', text: 'x'.repeat(65) },
    { kind: 'post', text: 'x', background_color: 'red' },
    { kind: 'post', text: 'x', mod_only: 'no' },
    { kind: 'post', text: 'bad\u0000text' },
  ])('refuses %o', async (body) => {
    await expect(validate(CreateFlairDto, body)).rejects.toThrow();
  });
});

describe('UpdateFlairDto', () => {
  it('needs a field, and clears the colour with null', async () => {
    await expect(validate(UpdateFlairDto, {})).rejects.toThrow();
    await expect(
      validate(UpdateFlairDto, { background_color: null }),
    ).resolves.toMatchObject({ background_color: null });
    await expect(validate(UpdateFlairDto, { kind: 'user' })).rejects.toThrow();
  });
});

describe('AssignUserFlairDto', () => {
  it('takes a flair id or null', async () => {
    await expect(
      validate(AssignUserFlairDto, { flair_id: null }),
    ).resolves.toMatchObject({ flair_id: null });
    await expect(
      validate(AssignUserFlairDto, { flair_id: 'not-a-uuid' }),
    ).rejects.toThrow();
  });
});

describe('CreateJoinRequestDto', () => {
  it('takes an optional message of at most 500 characters', async () => {
    await expect(validate(CreateJoinRequestDto, {})).resolves.toBeDefined();
    await expect(
      validate(CreateJoinRequestDto, { message: ' Hello ' }),
    ).resolves.toMatchObject({ message: 'Hello' });
    await expect(
      validate(CreateJoinRequestDto, { message: 'x'.repeat(501) }),
    ).rejects.toThrow();
  });
});
