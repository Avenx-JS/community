import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { UpdatePostDto } from './update-post.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (body: object) =>
  pipe.transform(body, {
    type: 'body',
    metatype: UpdatePostDto,
  }) as Promise<UpdatePostDto>;

describe('UpdatePostDto', () => {
  it('accepts title alone, content alone, or both, trimmed', async () => {
    await expect(validate({ title: '  New title  ' })).resolves.toEqual({
      title: 'New title',
    });
    await expect(validate({ content: ' Body ' })).resolves.toEqual({
      content: 'Body',
    });
    await expect(validate({ title: 'T', content: 'C' })).resolves.toEqual({
      title: 'T',
      content: 'C',
    });
  });

  it('accepts the bounds of CreatePostDto', async () => {
    await expect(
      validate({ title: 'x'.repeat(300), content: 'y'.repeat(16383) }),
    ).resolves.toBeDefined();
  });

  it('requires at least one field', async () => {
    await expect(validate({})).rejects.toMatchObject({
      response: {
        message: ['at least one of title or content must be provided'],
      },
    });
  });

  it.each([
    { title: '' },
    { title: '   ' },
    { title: 'x'.repeat(301) },
    { title: 'bad\u0000title' },
    { title: null },
    { title: 7 },
    { content: '' },
    { content: '  ' },
    { content: 'y'.repeat(16384) },
    { content: 'bad\u0007content' },
    { content: null },
  ])('rejects %o', async (body) => {
    await expect(validate(body)).rejects.toThrow();
  });

  // Immutable: refused by forbidNonWhitelisted, even next to a valid field.
  it.each([
    'type',
    'community_id',
    'author_id',
    'created_at',
    'id',
    'edited_at',
    'at_least_one_field',
  ])('rejects %s', async (property) => {
    await expect(validate({ title: 'T', [property]: 'x' })).rejects.toThrow();
  });
});
