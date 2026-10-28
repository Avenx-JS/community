import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRestrictionDto } from './create-restriction.dto';
import { LiftRestrictionDto } from './lift-restriction.dto';
import { ListRestrictionsDto } from './list-restrictions.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validateBody = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: CreateRestrictionDto });

describe('CreateRestrictionDto', () => {
  it('accepts a suspension with a duration and trims the reason', async () => {
    const dto = (await validateBody({
      type: 'suspension',
      reason: '  Spam  ',
      duration_hours: 72,
      report_id: 'report-1',
    })) as CreateRestrictionDto;

    expect(dto.reason).toBe('Spam');
    expect(dto.duration_hours).toBe(72);
  });

  it('accepts a ban without a duration', async () => {
    await expect(
      validateBody({ type: 'ban', reason: 'Abuse' }),
    ).resolves.toMatchObject({ type: 'ban' });
  });

  it.each([
    { type: 'suspension', reason: 'X' },
    { type: 'suspension', reason: 'X', duration_hours: null },
    { type: 'ban', reason: 'X', duration_hours: 24 },
    { type: 'ban', reason: 'X', duration_hours: null },
  ])('enforces the duration/type cross-field rule: %o', async (body) => {
    const dto = plainToInstance(CreateRestrictionDto, body);
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('type');
  });

  it.each([0, -1, 1.5, 8761, 'abc'])(
    'rejects out-of-range duration_hours %p',
    async (duration_hours) => {
      const dto = plainToInstance(CreateRestrictionDto, {
        type: 'suspension',
        reason: 'X',
        duration_hours,
      });
      const errors = await validate(dto);
      expect(errors.map((error) => error.property)).toContain('duration_hours');
    },
  );

  it.each([
    { type: 'warning', reason: 'X' },
    { type: 'ban' },
    { type: 'ban', reason: '   ' },
    { type: 'ban', reason: 'x'.repeat(2001) },
    { type: 'ban', reason: 'bad\u0000text' },
    { type: 'ban', reason: 'X', report_id: 'bad id' },
    { type: 'ban', reason: 'X', report_id: 'x'.repeat(37) },
  ])('rejects invalid input: %o', async (body) => {
    await expect(validateBody(body)).rejects.toThrow();
  });

  it.each(['created_by', 'expires_at', 'lifted_at', 'user_id', 'unknown'])(
    'rejects the non-whitelisted property %s',
    async (property) => {
      await expect(
        validateBody({ type: 'ban', reason: 'X', [property]: 'value' }),
      ).rejects.toThrow();
    },
  );
});

describe('LiftRestrictionDto', () => {
  it('requires a bounded plain-text lift_reason', async () => {
    const valid = plainToInstance(LiftRestrictionDto, {
      lift_reason: ' Appeal ',
    });
    expect(await validate(valid)).toHaveLength(0);
    expect(valid.lift_reason).toBe('Appeal');

    for (const body of [
      {},
      { lift_reason: '' },
      { lift_reason: 'x'.repeat(2001) },
      { lift_reason: 'bad\u0007text' },
    ]) {
      expect(
        await validate(plainToInstance(LiftRestrictionDto, body)),
      ).not.toHaveLength(0);
    }
  });
});

describe('ListRestrictionsDto', () => {
  it('defaults and bounds pagination', async () => {
    const dto = plainToInstance(ListRestrictionsDto, {});
    expect(dto).toMatchObject({ page: 1, limit: 20 });
    expect(await validate(dto)).toHaveLength(0);

    for (const query of [{ page: 0 }, { page: 10001 }, { limit: 101 }]) {
      expect(
        await validate(plainToInstance(ListRestrictionsDto, query)),
      ).not.toHaveLength(0);
    }
  });
});
