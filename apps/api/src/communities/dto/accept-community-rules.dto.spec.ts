import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { AcceptCommunityRulesDto } from './accept-community-rules.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const transform = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: AcceptCommunityRulesDto,
  }) as Promise<AcceptCommunityRulesDto>;

describe('AcceptCommunityRulesDto', () => {
  it('accepts a positive integer version', async () => {
    await expect(transform({ version: 1 })).resolves.toEqual({ version: 1 });
    await expect(transform({ version: 4294967295 })).resolves.toEqual({
      version: 4294967295,
    });
  });

  it.each([
    ['a missing version', {}],
    ['a null version', { version: null }],
    ['zero', { version: 0 }],
    ['a negative version', { version: -1 }],
    ['a fraction', { version: 1.5 }],
    ['a numeric string', { version: '2' }],
    ['a boolean', { version: true }],
    ['an out-of-range version', { version: 4294967296 }],
    ['a user_id', { version: 1, user_id: 'user-b' }],
    ['a community_id', { version: 1, community_id: 'community-1' }],
    ['a document_id', { version: 1, document_id: 'document-1' }],
  ])('rejects %s', async (_, body) => {
    await expect(transform(body)).rejects.toThrow();
  });
});
