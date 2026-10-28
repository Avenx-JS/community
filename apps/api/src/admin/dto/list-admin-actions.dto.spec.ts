import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ADMIN_ACTIONS } from '../audit-log.service';
import { ListAdminActionsDto } from './list-admin-actions.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validateQuery = (query: Record<string, unknown>) =>
  pipe.transform(query, { type: 'query', metatype: ListAdminActionsDto });

describe('ListAdminActionsDto', () => {
  it('provides defaults and transforms pagination values', async () => {
    const dto = plainToInstance(ListAdminActionsDto, {
      page: '2',
      limit: '50',
    });

    expect(dto).toMatchObject({ page: 2, limit: 50, sort: 'new' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts every action in the shared vocabulary', async () => {
    for (const action of ADMIN_ACTIONS) {
      expect(
        await validate(plainToInstance(ListAdminActionsDto, { action })),
      ).toHaveLength(0);
    }
  });

  it('accepts target_id together with target_type', async () => {
    await expect(
      validateQuery({ target_type: 'user', target_id: 'user-1' }),
    ).resolves.toMatchObject({ target_type: 'user', target_id: 'user-1' });
  });

  it('requires target_type when target_id is given', async () => {
    const errors = await validate(
      plainToInstance(ListAdminActionsDto, { target_id: 'user-1' }),
    );
    expect(errors.map((error) => error.property)).toEqual(['target_id']);
  });

  it.each([
    { actor_username: 'ab' },
    { actor_username: 'x'.repeat(51) },
    { actor_username: 'bad-name' },
    { action: 'user_deleted' },
    { target_type: 'post' },
    { target_type: 'user', target_id: 'bad id' },
    { target_type: 'user', target_id: 'x'.repeat(37) },
    { from: 'yesterday' },
    { to: '2026-13-01' },
    { page: 0 },
    { page: 10001 },
    { limit: 0 },
    { limit: 101 },
    { sort: 'random' },
  ])('rejects invalid query %o', async (query) => {
    await expect(validateQuery(query)).rejects.toThrow();
  });

  it('rejects unknown parameters', async () => {
    await expect(validateQuery({ actor_id: 'admin-id' })).rejects.toThrow();
  });
});
