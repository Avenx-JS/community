import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  COMMUNITY_MODERATION_ACTIONS,
  COMMUNITY_MODERATION_TARGETS,
} from '../community-moderation-log.service';
import { ListCommunityModerationActionsDto } from './list-community-moderation-actions.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validateQuery = (query: Record<string, unknown>) =>
  pipe.transform(query, {
    type: 'query',
    metatype: ListCommunityModerationActionsDto,
  });

describe('ListCommunityModerationActionsDto', () => {
  it('provides defaults and transforms pagination values', async () => {
    await expect(validateQuery({})).resolves.toMatchObject({
      page: 1,
      limit: 20,
      sort: 'new',
    });
    await expect(
      validateQuery({ page: '2', limit: '50', sort: 'oldest' }),
    ).resolves.toMatchObject({ page: 2, limit: 50, sort: 'oldest' });
  });

  it('accepts every action and target type in the shared vocabulary', async () => {
    for (const action of COMMUNITY_MODERATION_ACTIONS) {
      expect(
        await validate(
          plainToInstance(ListCommunityModerationActionsDto, { action }),
        ),
      ).toHaveLength(0);
    }
    for (const target_type of COMMUNITY_MODERATION_TARGETS) {
      expect(
        await validate(
          plainToInstance(ListCommunityModerationActionsDto, { target_type }),
        ),
      ).toHaveLength(0);
    }
  });

  it.each([
    { actor_username: 'mod' },
    { actor_username: 'x'.repeat(50) },
    { from: '2026-10-01', to: '2026-10-02T00:00:00Z' },
    { from: '2026-10-01T00:00:00+02:00' },
    { page: '10000', limit: '100' },
  ])('accepts %o', async (query) => {
    await expect(validateQuery(query)).resolves.toBeInstanceOf(
      ListCommunityModerationActionsDto,
    );
  });

  it.each([
    { actor_username: 'ab' },
    { actor_username: 'x'.repeat(51) },
    { actor_username: 'bad-name' },
    { action: 'user_banned' },
    { target_type: 'report' },
    { from: 'yesterday' },
    { to: '2026-13-01' },
    { page: 0 },
    { page: 10001 },
    { page: 'one' },
    { limit: 0 },
    { limit: 101 },
    { sort: 'random' },
  ])('rejects invalid query %o', async (query) => {
    await expect(validateQuery(query)).rejects.toThrow();
  });

  it.each(['actor_id', 'target_id', 'community_id', 'unknown'])(
    'rejects the unknown parameter %s',
    async (key) => {
      await expect(validateQuery({ [key]: 'value' })).rejects.toThrow();
    },
  );
});
