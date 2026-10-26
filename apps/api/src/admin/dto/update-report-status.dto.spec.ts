import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from '@jest/globals';
import { validate } from 'class-validator';
import { UpdateReportStatusDto } from './update-report-status.dto';

describe('UpdateReportStatusDto', () => {
  it.each([
    [{ status: 'under_review' }],
    [{ status: 'rejected', resolution_note: 'Not a violation.' }],
    [{ status: 'resolved', resolution: 'no_action' }],
  ])('accepts valid transition payloads: %o', async (body) => {
    const dto = plainToInstance(UpdateReportStatusDto, body);
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([
    {},
    { status: 'open' },
    { status: 'resolved' },
    { status: 'resolved', resolution: 'unknown' },
    { status: 'rejected', resolution: 'no_action' },
    { status: 'under_review', resolution: null },
    { status: 'resolved', resolution: 'no_action', reviewed_by: 'admin-id' },
    { status: 'rejected', resolution_note: 'contains\u0000control' },
    { status: 'rejected', resolution_note: 'x'.repeat(2001) },
  ])('rejects invalid transition payloads: %o', async (body) => {
    const dto = plainToInstance(UpdateReportStatusDto, body);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('trims resolution notes', () => {
    const dto = plainToInstance(UpdateReportStatusDto, {
      status: 'resolved',
      resolution: 'no_action',
      resolution_note: '  reviewed  ',
    });
    expect(dto.resolution_note).toBe('reviewed');
  });
});
