import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { UpdateCommentDto } from './update-comment.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (body: object) =>
  pipe.transform(body, { type: 'body', metatype: UpdateCommentDto });

describe('UpdateCommentDto', () => {
  it('accepts trimmed content within the bounds of CreateCommentDto', async () => {
    await expect(validate({ content: '  Fixed  ' })).resolves.toEqual({
      content: 'Fixed',
    });
    await expect(
      validate({ content: 'x'.repeat(16383) }),
    ).resolves.toBeDefined();
  });

  it.each([
    {},
    { content: '' },
    { content: '   ' },
    { content: 'x'.repeat(16384) },
    { content: 'bad\u0000content' },
    { content: null },
    { content: 3 },
  ])('rejects %o', async (body) => {
    await expect(validate(body)).rejects.toThrow();
  });

  // parent_id is immutable: re-parenting would move a subtree.
  it.each(['parent_id', 'post_id', 'author_id', 'edited_at', 'id'])(
    'rejects %s',
    async (property) => {
      await expect(
        validate({ content: 'Fixed', [property]: 'x' }),
      ).rejects.toThrow();
    },
  );
});
