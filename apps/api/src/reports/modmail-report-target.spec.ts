import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import { REPORT_TARGET_TYPES } from './report.constants';
import { REPORT_TARGET_JOINS_SQL } from './report-target.sql';
import { REPORTED_MODMAIL_SQL, ReportsService } from './reports.service';

type Resolver = {
  resolveTarget(
    input: { target_type: string; target: string },
    reporterId: string,
  ): Promise<Record<string, unknown>>;
};

// A modmail message as a report target (migration 046).
describe('modmail_message report target', () => {
  const resolve = (
    row: Record<string, unknown> | undefined,
    reporter: string,
  ) => {
    const calls: unknown[][] = [];
    const service = new ReportsService({
      execute: (sql: string, values: unknown[]) => {
        calls.push([sql, values]);
        return Promise.resolve([row ? [row] : [], []]);
      },
    } as unknown as Pool) as unknown as Resolver;
    return {
      calls,
      result: service.resolveTarget(
        { target_type: 'modmail_message', target: 'msg-1' },
        reporter,
      ),
    };
  };

  it('is a target type, joined for the labels', () => {
    expect(REPORT_TARGET_TYPES).toContain('modmail_message');
    expect(REPORT_TARGET_JOINS_SQL).toContain(
      "ur.target_type = 'modmail_message' AND target_modmail.id = ur.target_id",
    );
  });

  it("lets the thread's user report a team message, for administrators, naming the moderator to them only", async () => {
    const { calls, result } = resolve(
      { author_id: 'mod', user_id: 'appellant', can_moderate: 0 },
      'appellant',
    );
    await expect(result).resolves.toEqual({
      type: 'modmail_message',
      id: 'msg-1',
      reportedUserId: 'mod',
      targetAuthorId: 'mod',
      reportedUsername: null,
      communityId: null,
    });
    expect(calls).toEqual([
      [REPORTED_MODMAIL_SQL, ['appellant', 'appellant', 'msg-1']],
    ]);
  });

  it("lets a moderator report the user's message", async () => {
    await expect(
      resolve(
        { author_id: 'appellant', user_id: 'appellant', can_moderate: 1 },
        'mod',
      ).result,
    ).resolves.toMatchObject({
      reportedUserId: 'appellant',
      communityId: null,
    });
  });

  it('answers 404 to anyone outside the thread, and for an unknown message', async () => {
    await expect(
      resolve(
        { author_id: 'mod', user_id: 'appellant', can_moderate: 0 },
        'stranger',
      ).result,
    ).rejects.toMatchObject({ status: 404 });
    await expect(resolve(undefined, 'appellant').result).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses reporting your own message with 400', async () => {
    await expect(
      resolve(
        { author_id: 'appellant', user_id: 'appellant', can_moderate: 0 },
        'appellant',
      ).result,
    ).rejects.toMatchObject({ status: 400 });
  });
});
