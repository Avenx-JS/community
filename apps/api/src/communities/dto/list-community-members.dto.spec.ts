import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListCommunityMembersDto } from './list-community-members.dto';
import { ListCommunityModeratorsDto } from './list-community-moderators.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validateMembers = (query: Record<string, unknown>) =>
  pipe.transform(query, { type: 'query', metatype: ListCommunityMembersDto });
const validateModerators = (query: Record<string, unknown>) =>
  pipe.transform(query, {
    type: 'query',
    metatype: ListCommunityModeratorsDto,
  });

describe('ListCommunityMembersDto', () => {
  it('provides defaults and transforms pagination values', async () => {
    const dto = plainToInstance(ListCommunityMembersDto, {
      page: '2',
      limit: '10',
    });

    expect(dto).toMatchObject({ page: 2, limit: 10, sort: 'new' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([
    { search: 'mod' },
    { search: '100%_=' },
    { search: 'x'.repeat(50) },
    { sort: 'oldest' },
    { page: '10000', limit: '100' },
  ])('accepts %o', async (query) => {
    await expect(validateMembers(query)).resolves.toBeInstanceOf(
      ListCommunityMembersDto,
    );
  });

  it.each([
    { search: 'x'.repeat(51) },
    { search: 'contains\u0000control' },
    { search: ['a', 'b'] },
    { page: 0 },
    { page: 10001 },
    { page: 'one' },
    { limit: 0 },
    { limit: 101 },
    { sort: 'username' },
    { sort: 'random' },
  ])('rejects %o', async (query) => {
    await expect(validateMembers(query)).rejects.toThrow();
  });

  it.each(['role', 'user_id', 'email', 'community_id', 'unknown'])(
    'rejects the unknown parameter %s',
    async (key) => {
      await expect(validateMembers({ [key]: 'value' })).rejects.toThrow();
    },
  );
});

describe('ListCommunityModeratorsDto', () => {
  it('provides defaults', async () => {
    await expect(validateModerators({})).resolves.toMatchObject({
      page: 1,
      limit: 20,
    });
  });

  it.each([
    { page: 0 },
    { page: 10001 },
    { limit: 0 },
    { limit: 101 },
    { sort: 'new' },
    { search: 'mod' },
  ])('rejects %o', async (query) => {
    await expect(validateModerators(query)).rejects.toThrow();
  });
});
