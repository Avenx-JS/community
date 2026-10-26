import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListUsersDto } from './list-users.dto';

describe('ListUsersDto', () => {
  it('provides defaults and transforms pagination values', async () => {
    const dto = plainToInstance(ListUsersDto, { page: '2', limit: '10' });

    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(10);
    expect(dto.sort).toBe('new');
    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([
    { search: 'x'.repeat(101) },
    { search: 'contains\u0000control' },
    { role: 'owner' },
    { status: 'restricted' },
    { from: 'not-a-date' },
    { page: 0 },
    { limit: 101 },
    { sort: 'random' },
  ])('rejects invalid filters: %o', async (query) => {
    const dto = plainToInstance(ListUsersDto, query);
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
