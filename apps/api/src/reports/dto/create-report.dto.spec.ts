import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from '@jest/globals';
import { validate } from 'class-validator';
import { CreateReportDto } from './create-report.dto';

const USER = { target_type: 'user', target: 'reported_user', reason: 'spam' };
const validateBody = (value: object) =>
  validate(plainToInstance(CreateReportDto, value));

describe('CreateReportDto', () => {
  it('accepts a complete valid report and a bare one', async () => {
    for (const value of [
      USER,
      {
        ...USER,
        reason: 'other',
        description: 'Plain text detail',
        context_type: 'post',
        context_id: 'post-1',
      },
    ]) {
      await expect(validateBody(value)).resolves.toHaveLength(0);
    }
  });

  describe('the discriminator', () => {
    it.each(['user', 'post', 'comment', 'community'])(
      'accepts target_type %s',
      async (target_type) => {
        await expect(
          validateBody({ target_type, target: 'some-target', reason: 'spam' }),
        ).resolves.toHaveLength(0);
      },
    );

    it.each(['account', 'POST', '', 42, null])(
      'rejects target_type %j',
      async (target_type) => {
        const errors = await validateBody({ ...USER, target_type });
        expect(errors.some((e) => e.property === 'target_type')).toBe(true);
      },
    );

    it('requires target_type', async () => {
      const errors = await validateBody({ target: 'x', reason: 'spam' });
      expect(errors.some((e) => e.property === 'target_type')).toBe(true);
    });
  });

  describe('the combined target pattern', () => {
    // Both forms must pass here: the per-type check runs in the service.
    it.each(['a', 'user_name', 'community-name', 'A1_-', 'x'.repeat(50)])(
      'accepts %s',
      async (target) => {
        await expect(validateBody({ ...USER, target })).resolves.toHaveLength(
          0,
        );
      },
    );

    it.each(['', 'x'.repeat(51), 'has space', "x' OR 1=1", 'a/b', 42, null])(
      'rejects %j',
      async (target) => {
        const errors = await validateBody({ ...USER, target });
        expect(errors.some((e) => e.property === 'target')).toBe(true);
      },
    );

    it('requires target, and trims it', async () => {
      const errors = await validateBody({
        target_type: 'user',
        reason: 'spam',
      });
      expect(errors.some((e) => e.property === 'target')).toBe(true);

      const dto = plainToInstance(CreateReportDto, {
        ...USER,
        target: '  reported_user ',
      });
      await expect(validate(dto)).resolves.toHaveLength(0);
      expect(dto.target).toBe('reported_user');
    });
  });

  describe('the context pair', () => {
    it.each([
      { context_type: 'post' },
      { context_id: 'post-1' },
      { context_type: null },
      { context_type: null, context_id: null },
    ])('rejects an incomplete pair on a user target: %o', async (context) => {
      await expect(
        validateBody({ ...USER, ...context }),
      ).resolves.not.toHaveLength(0);
    });

    it.each(['post', 'comment', 'community'])(
      'rejects a complete pair on a %s target',
      async (target_type) => {
        const errors = await validateBody({
          target_type,
          target: 'some-target',
          reason: 'spam',
          context_type: 'post',
          context_id: 'post-1',
        });
        expect(JSON.stringify(errors)).toContain(
          'only allowed when target_type is user',
        );
      },
    );

    it.each(['post', 'comment', 'community'])(
      'rejects half a pair on a %s target',
      async (target_type) => {
        for (const context of [
          { context_type: 'post' },
          { context_id: 'post-1' },
        ]) {
          await expect(
            validateBody({
              target_type,
              target: 'some-target',
              reason: 'spam',
              ...context,
            }),
          ).resolves.not.toHaveLength(0);
        }
      },
    );

    it.each(['post', 'comment', 'community'])(
      'accepts a %s target with no context',
      async (target_type) => {
        await expect(
          validateBody({ target_type, target: 'some-target', reason: 'spam' }),
        ).resolves.toHaveLength(0);
      },
    );
  });

  // Under the global pipe, as POST /reports really runs.
  describe('unknown properties', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const run = (body: object) =>
      pipe.transform(body, { type: 'body', metatype: CreateReportDto });

    it('accepts the new shape', async () => {
      await expect(run(USER)).resolves.toBeInstanceOf(CreateReportDto);
    });

    it('rejects the removed username field, alone or alongside a target', async () => {
      await expect(
        run({ username: 'reported_user', reason: 'spam' }),
      ).rejects.toThrow();
      await expect(
        run({ ...USER, username: 'reported_user' }),
      ).rejects.toThrow();
    });

    it.each([
      { reporter_id: 'someone' },
      { status: 'resolved' },
      { target_id: 'some-id' },
    ])('rejects %o', async (extra) => {
      await expect(run({ ...USER, ...extra })).rejects.toThrow();
    });
  });

  it('rejects reasons outside the schema vocabulary', async () => {
    const errors = await validateBody({ ...USER, reason: 'unlisted_reason' });
    expect(errors.some((error) => error.property === 'reason')).toBe(true);
  });

  it('trims and validates plain-text descriptions', async () => {
    const dto = plainToInstance(CreateReportDto, {
      ...USER,
      description: '  plain detail  ',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.description).toBe('plain detail');

    const errors = await validateBody({
      ...USER,
      description: `bad${String.fromCharCode(1)}text`,
    });
    expect(errors.some((error) => error.property === 'description')).toBe(true);
  });
});
