import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from '@jest/globals';
import { validate } from 'class-validator';
import { CreateReportDto } from './create-report.dto';

describe('CreateReportDto', () => {
  it('accepts a complete valid report and a user-level report', async () => {
    for (const value of [
      {
        username: 'reported_user',
        reason: 'spam',
      },
      {
        username: 'reported_user',
        reason: 'other',
        description: 'Plain text detail',
        context_type: 'post',
        context_id: 'post-1',
      },
    ]) {
      await expect(
        validate(plainToInstance(CreateReportDto, value)),
      ).resolves.toHaveLength(0);
    }
  });

  it.each([
    { context_type: 'post' },
    { context_id: 'post-1' },
    { context_type: null },
    { context_type: null, context_id: null },
  ])('rejects incomplete context pairs: %o', async (partialContext) => {
    const errors = await validate(
      plainToInstance(CreateReportDto, {
        username: 'reported_user',
        reason: 'spam',
        ...partialContext,
      }),
    );

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects reasons outside the schema vocabulary', async () => {
    const errors = await validate(
      plainToInstance(CreateReportDto, {
        username: 'reported_user',
        reason: 'unlisted_reason',
      }),
    );

    expect(errors.some((error) => error.property === 'reason')).toBe(true);
  });

  it('trims and validates plain-text descriptions', async () => {
    const dto = plainToInstance(CreateReportDto, {
      username: 'reported_user',
      reason: 'spam',
      description: '  plain detail  ',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.description).toBe('plain detail');

    const invalid = plainToInstance(CreateReportDto, {
      username: 'reported_user',
      reason: 'spam',
      description: `bad${String.fromCharCode(1)}text`,
    });
    const errors = await validate(invalid);
    expect(errors.some((error) => error.property === 'description')).toBe(true);
  });
});
