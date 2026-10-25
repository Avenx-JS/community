import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from '@jest/globals';
import { validate } from 'class-validator';
import { ListReportsDto } from './list-reports.dto';

describe('ListReportsDto', () => {
  it('applies pagination and sort defaults', () => {
    const dto = plainToInstance(ListReportsDto, {});
    expect(dto).toMatchObject({ page: 1, limit: 20, sort: 'new' });
  });

  it.each([
    { page: '0' },
    { page: '10001' },
    { limit: '0' },
    { limit: '101' },
    { status: 'unknown' },
    { reason: 'unknown' },
    { sort: 'random' },
    { reported_username: 'bad-name' },
    { reporter_username: 'x' },
    { from: 'not-a-date' },
    { to: '2026-13-50' },
    { unexpected: 'value' },
  ])('rejects invalid filters and parameters: %o', async (input) => {
    const dto = plainToInstance(ListReportsDto, input);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('transforms and accepts valid filters', async () => {
    const dto = plainToInstance(ListReportsDto, {
      status: 'open',
      reason: 'spam',
      reported_username: 'target_user',
      reporter_username: 'reporter',
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
      page: '2',
      limit: '25',
      sort: 'oldest',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto).toMatchObject({ page: 2, limit: 25, sort: 'oldest' });
  });
});
