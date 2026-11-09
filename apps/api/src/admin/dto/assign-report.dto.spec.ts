import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { AssignReportDto } from './assign-report.dto';

// Under the global pipe, as POST /admin/reports/:id/assign really runs.
describe('AssignReportDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const run = (body: object) =>
    pipe.transform(body, { type: 'body', metatype: AssignReportDto });

  it('accepts an empty body, meaning the caller', async () => {
    await expect(run({})).resolves.toEqual(new AssignReportDto());
  });

  it.each(['abc', 'second_admin', 'A1_b2', 'x'.repeat(50)])(
    'accepts the username %s',
    async (username) => {
      await expect(run({ username })).resolves.toMatchObject({ username });
    },
  );

  it.each([
    '',
    'ab',
    'x'.repeat(51),
    'has-hyphen',
    'has space',
    "x' OR 1=1",
    42,
    null,
  ])('rejects the username %j', async (username) => {
    await expect(run({ username })).rejects.toThrow();
  });

  it.each([
    { user_id: 'admin-id' },
    { assignee_id: 'admin-id' },
    { username: 'admin', status: 'under_review' },
    { username: 'admin', assigned_at: '2026-01-01T00:00:00Z' },
  ])('rejects the unknown property in %o', async (body) => {
    await expect(run(body)).rejects.toThrow();
  });
});
