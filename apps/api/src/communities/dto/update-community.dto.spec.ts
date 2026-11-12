import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { DeleteCommunityDto } from './delete-community.dto';
import { UpdateCommunityDto } from './update-community.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validateUpdate = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: UpdateCommunityDto });
const validateDelete = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: DeleteCommunityDto });

describe('UpdateCommunityDto', () => {
  it('trims the description', async () => {
    await expect(
      validateUpdate({ description: '  Growing plants \n' }),
    ).resolves.toMatchObject({ description: 'Growing plants' });
  });

  it('accepts an empty or whitespace-only description, which clears it', async () => {
    await expect(validateUpdate({ description: '' })).resolves.toMatchObject({
      description: '',
    });
    await expect(
      validateUpdate({ description: ' \t\n ' }),
    ).resolves.toMatchObject({ description: '' });
  });

  it('accepts the maximum length and multi-line text', async () => {
    await expect(
      validateUpdate({ description: 'x'.repeat(16383) }),
    ).resolves.toBeInstanceOf(UpdateCommunityDto);
    await expect(
      validateUpdate({ description: 'Line one\nLine two\tindented' }),
    ).resolves.toBeInstanceOf(UpdateCommunityDto);
  });

  it('requires at least one field', async () => {
    await expect(validateUpdate({})).rejects.toThrow();
  });

  it.each([
    [{ description: 'x'.repeat(16384) }],
    [{ description: 'bell\u0007' }],
    [{ description: null }],
    [{ description: 42 }],
    [{ description: ['a'] }],
  ])('rejects the invalid description %o', async (body) => {
    await expect(validateUpdate(body)).rejects.toThrow();
  });

  it.each([
    [{ name: 'renamed' }],
    [{ description: 'ok', name: 'renamed' }],
    [{ rules: 'Be kind' }],
    [{ description: 'ok', rules: [{ title: 'Be kind' }] }],
    [{ description: 'ok', creator_id: 'someone' }],
    [{ description: 'ok', deleted_at: null }],
    [{ description: 'ok', at_least_one_field: true }],
    [{ description: 'ok', unknown: 1 }],
  ])('rejects the non-editable or unknown property in %o', async (body) => {
    await expect(validateUpdate(body)).rejects.toThrow();
  });
});

describe('DeleteCommunityDto', () => {
  it('accepts a confirmation name', async () => {
    await expect(validateDelete({ name: 'gardening' })).resolves.toEqual(
      Object.assign(new DeleteCommunityDto(), { name: 'gardening' }),
    );
  });

  it('does not trim the confirmation, which must match exactly', async () => {
    await expect(
      validateDelete({ name: ' gardening ' }),
    ).resolves.toMatchObject({ name: ' gardening ' });
  });

  it.each([
    [{}],
    [{ name: '' }],
    [{ name: 'x'.repeat(51) }],
    [{ name: 42 }],
    [{ name: 'gardening', confirm: true }],
  ])('rejects %o', async (body) => {
    await expect(validateDelete(body)).rejects.toThrow();
  });
});

// Migration 038: the community settings.
describe('UpdateCommunityDto settings', () => {
  it('accepts each setting on its own', async () => {
    for (const visibility of ['public', 'restricted', 'private']) {
      await expect(validateUpdate({ visibility })).resolves.toMatchObject({
        visibility,
      });
    }
    await expect(validateUpdate({ nsfw: true })).resolves.toMatchObject({
      nsfw: true,
    });
    await expect(
      validateUpdate({ allowed_post_types: ['text', 'media'] }),
    ).resolves.toMatchObject({ allowed_post_types: ['text', 'media'] });
  });

  it.each([
    { visibility: 'hidden' },
    { visibility: null },
    { nsfw: 'yes' },
    { nsfw: null },
    { allowed_post_types: [] },
    { allowed_post_types: ['text', 'text'] },
    { allowed_post_types: ['video'] },
    { allowed_post_types: 'text' },
  ])('refuses %o', async (body) => {
    await expect(validateUpdate(body)).rejects.toThrow();
  });
});
