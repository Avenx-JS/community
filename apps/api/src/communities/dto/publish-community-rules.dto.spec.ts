import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { PublishCommunityRulesDto } from './publish-community-rules.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const transform = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: PublishCommunityRulesDto,
  }) as Promise<PublishCommunityRulesDto>;

const items = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ title: `Rule ${index}` }));

describe('PublishCommunityRulesDto', () => {
  it('accepts 1 to 50 items and trims titles and bodies', async () => {
    await expect(transform({ items: items(1) })).resolves.toBeDefined();
    await expect(transform({ items: items(50) })).resolves.toBeDefined();

    const dto = await transform({
      items: [{ title: '  Be kind  ', body: '\n No insults. \n' }],
    });
    expect(dto.items[0]).toEqual({ title: 'Be kind', body: 'No insults.' });
  });

  it('stores a missing, null, or whitespace-only body as null', async () => {
    const dto = await transform({
      items: [
        { title: 'A', body: ' \n\t ' },
        { title: 'B', body: null },
        { title: 'C' },
      ],
    });
    expect(dto.items.map((item) => item.body ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('accepts bodies at the length bounds', async () => {
    await expect(
      transform({
        items: [{ title: 'x'.repeat(200), body: 'y'.repeat(4000) }],
      }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['no items', {}],
    ['items is not an array', { items: 'Be kind' }],
    ['zero items', { items: [] }],
    ['more than 50 items', { items: items(51) }],
    ['a non-object item', { items: ['Be kind'] }],
    ['a missing title', { items: [{ body: 'x' }] }],
    ['a blank title', { items: [{ title: '   ' }] }],
    ['a non-string title', { items: [{ title: 5 }] }],
    ['a title over 200 characters', { items: [{ title: 'x'.repeat(201) }] }],
    [
      'a body over 4,000 characters',
      { items: [{ title: 'A', body: 'y'.repeat(4001) }] },
    ],
    ['a control character in a title', { items: [{ title: 'A\u0000' }] }],
    [
      'a control character in a body',
      { items: [{ title: 'A', body: 'B\u0007' }] },
    ],
    ['a client-supplied position', { items: [{ title: 'A', position: 1 }] }],
    ['an unknown item property', { items: [{ title: 'A', id: 'x' }] }],
    ['an unknown top-level property', { items: items(1), version: 3 }],
  ])('rejects %s', async (_, body) => {
    await expect(transform(body)).rejects.toThrow();
  });
});
