import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CreateAppealDto,
  DecideAppealDto,
  ListAdminAppealsDto,
} from './appeals.dto';

const errors = <T extends object>(type: new () => T, body: object) =>
  validateSync(plainToInstance(type, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((error) => error.property);

describe('appeal DTOs', () => {
  const appeal = {
    target_type: 'restriction',
    target_id: 'r-1',
    reason: 'I did not spam anyone.',
  };

  it('accepts an appeal and trims its reason', () => {
    const dto = plainToInstance(CreateAppealDto, {
      ...appeal,
      reason: '  I did not spam anyone.  ',
    });
    expect(validateSync(dto)).toEqual([]);
    expect(dto.reason).toBe('I did not spam anyone.');
  });

  it.each([
    ['a reason under 10 characters once trimmed', { reason: '   short   ' }],
    ['a reason over 2000 characters', { reason: 'r'.repeat(2001) }],
    ['a reason with control characters', { reason: 'I did not\u0000 spam.' }],
    ['an unknown target type', { target_type: 'community_ban' }],
    ['a malformed target id', { target_id: '../r-1' }],
  ])('refuses %s', (_case, change) => {
    expect(errors(CreateAppealDto, { ...appeal, ...change })).not.toEqual([]);
  });

  it('requires a decision and a note', () => {
    expect(
      errors(DecideAppealDto, { status: 'approved', decision_note: 'Ok' }),
    ).toEqual([]);
    expect(errors(DecideAppealDto, { status: 'approved' })).toEqual([
      'decision_note',
    ]);
    expect(
      errors(DecideAppealDto, { status: 'open', decision_note: 'Ok' }),
    ).toEqual(['status']);
    expect(
      errors(DecideAppealDto, { status: 'rejected', decision_note: '   ' }),
    ).toEqual(['decision_note']);
  });

  it('filters the queue by status, any, and target type', () => {
    expect(errors(ListAdminAppealsDto, { status: 'any' })).toEqual([]);
    expect(
      errors(ListAdminAppealsDto, {
        status: 'approved',
        target_type: 'comment_removal',
        page: '2',
      }),
    ).toEqual([]);
    expect(errors(ListAdminAppealsDto, { status: 'closed' })).toEqual([
      'status',
    ]);
  });
});
