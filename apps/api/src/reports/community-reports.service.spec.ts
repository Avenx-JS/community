import { describe, expect, it, jest } from '@jest/globals';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import type { CommentRemovalService } from '../comments/comment-removals.service';
import { visibleCommunityColumnsSql } from '../common/community-visibility';
import type { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import type { PostsService } from '../posts/posts.service';
import {
  CLOSE_COMMUNITY_REPORTS_SQL,
  closeCommunityReports,
  OPEN_COMMUNITY_REPORT_SQL,
} from './community-report-review';
import {
  CommunityReportsService,
  MODERATED_COMMUNITY_SQL,
  modQueueCountSql,
  modQueueSql,
} from './community-reports.service';
import { ReportsService } from './reports.service';

type Answer = unknown[] | { affectedRows: number };

// A database answering by statement prefix, logging every statement.
function harness(answers: Array<[RegExp | string, Answer | (() => Answer)]>) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const log: string[] = [];
  const execute = (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    for (const [match, answer] of answers) {
      if (
        typeof match === 'string'
          ? sql.startsWith(match) || sql === match
          : match.test(sql)
      ) {
        return Promise.resolve([
          typeof answer === 'function' ? answer() : answer,
          [],
        ]);
      }
    }
    return Promise.resolve([[], []]);
  };
  const connection = {
    execute,
    beginTransaction: () => {
      log.push('begin');
      return Promise.resolve();
    },
    commit: () => {
      log.push('commit');
      return Promise.resolve();
    },
    rollback: () => {
      log.push('rollback');
      return Promise.resolve();
    },
    release: () => undefined,
  };
  const pool = {
    execute,
    getConnection: () => Promise.resolve(connection),
  } as unknown as Pool;
  const record = jest.fn<(...args: unknown[]) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const removeContentOn = jest.fn<(...args: unknown[]) => Promise<unknown>>(
    () => Promise.resolve({}),
  );
  const removeOn = jest.fn<(...args: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve({}),
  );
  const service = new CommunityReportsService(
    pool,
    { record } as unknown as CommunityModerationLogService,
    { removeContentOn } as unknown as PostsService,
    { removeOn } as unknown as CommentRemovalService,
  );
  return {
    service,
    statements,
    log,
    record,
    removeContentOn,
    removeOn,
    connection,
  };
}

// The unlocked read of the report to decide.
const REPORT_READ =
  /WHERE id = \? AND community_id = \? AND withdrawn_at IS NULL\s+LIMIT 1$/;

const MODERATOR: [string, Answer] = [
  MODERATED_COMMUNITY_SQL,
  [{ id: 'c-1', can_moderate: 1 }],
];
const openReport = (overrides: Record<string, unknown> = {}) => [
  {
    id: 'r-1',
    target_type: 'post',
    target_id: 'p-1',
    reason: 'spam',
    description: null,
    created_at: new Date('2026-11-12T08:00:00Z'),
    community_status: 'open',
    community_reviewed_at: null,
    ...overrides,
  },
];

describe('community report access', () => {
  it('resolves the community by name with the shared visibility predicate, bound to the caller', async () => {
    expect(MODERATED_COMMUNITY_SQL).toContain(
      `WHERE c.name = ? AND ${visibleCommunityColumnsSql('c')}`,
    );
    const { service, statements } = harness([MODERATOR]);
    await service.modQueue('garden', 'u-mod', {});
    expect(statements[0]).toEqual({
      sql: MODERATED_COMMUNITY_SQL,
      values: ['u-mod', 'u-mod', 'garden'],
    });
  });

  it('answers 404 before 403, and 403 to anyone who does not moderate it', async () => {
    await expect(
      harness([[MODERATED_COMMUNITY_SQL, []]]).service.modQueue(
        'gone',
        'u',
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // A platform administrator who does not moderate it included: they
    // review reports under /admin.
    await expect(
      harness([
        [MODERATED_COMMUNITY_SQL, [{ id: 'c-1', can_moderate: 0 }]],
      ]).service.list('garden', 'platform-admin', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('the queue SQL', () => {
  it('groups open, unwithdrawn reports of the community by their content', () => {
    const sql = modQueueSql('oldest', false);
    expect(sql).toContain(
      `WHERE community_id = ? AND ${OPEN_COMMUNITY_REPORT_SQL}`,
    );
    expect(sql).toContain('GROUP BY target_type, target_id');
    expect(OPEN_COMMUNITY_REPORT_SQL).toBe(
      "community_status = 'open' AND withdrawn_at IS NULL",
    );
    expect(modQueueCountSql(true)).toContain('AND target_type = ?');
  });

  it.each([
    [
      'oldest',
      'ORDER BY first_reported_at ASC, target_type ASC, target_id ASC',
    ],
    [
      'newest',
      'ORDER BY last_reported_at DESC, target_type ASC, target_id ASC',
    ],
    [
      'most_reported',
      'ORDER BY report_count DESC, first_reported_at ASC, target_type ASC',
    ],
  ] as const)('sorts %s with a total order', (sort, order) => {
    expect(modQueueSql(sort, false)).toContain(order);
  });
});

describe('approve', () => {
  it('locks the report, closes the entry as approved and logs it, in one transaction', async () => {
    const { service, statements, log, record } = harness([
      MODERATOR,
      [/FOR UPDATE$/, openReport()],
      [CLOSE_COMMUNITY_REPORTS_SQL, { affectedRows: 3 }],
      [
        /LEFT JOIN users reviewer/,
        openReport({ community_status: 'approved' }),
      ],
    ]);
    await service.approve('garden', 'u-mod', 'r-1');
    const lock = statements.find(({ sql }) => /FOR UPDATE$/.test(sql));
    expect(lock?.values).toEqual(['r-1', 'c-1']);
    expect(
      statements.find(({ sql }) => sql === CLOSE_COMMUNITY_REPORTS_SQL)?.values,
    ).toEqual(['approved', 'u-mod', 'c-1', 'post', 'p-1']);
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      actorId: 'u-mod',
      communityId: 'c-1',
      action: 'report_approved',
      targetType: 'post',
      targetId: 'p-1',
      metadata: { reports: 3 },
    });
    expect(log).toEqual(['begin', 'commit']);
  });

  it('answers 409 for a closed report and 404 for a withdrawn or foreign one, rolling back', async () => {
    const closed = harness([
      MODERATOR,
      [/FOR UPDATE$/, openReport({ community_status: 'removed' })],
    ]);
    await expect(
      closed.service.approve('garden', 'u-mod', 'r-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(closed.log).toEqual(['begin', 'rollback']);
    const missing = harness([MODERATOR]);
    await expect(
      missing.service.approve('garden', 'u-mod', 'r-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('remove', () => {
  // The content row is locked first, then the reports, as by the content's
  // own removal route: the two paths can never deadlock.
  it('reads the report without a lock and removes through the post removal path on the same connection', async () => {
    const h = harness([
      MODERATOR,
      [REPORT_READ, openReport()],
      [/^SELECT removed_at FROM posts/, [{ removed_at: null }]],
      [/LEFT JOIN users reviewer/, openReport({ community_status: 'removed' })],
    ]);
    await h.service.remove('garden', 'u-mod', 'r-1', { reason: 'Spam' });
    expect(
      h.statements.some(({ sql }) => /user_reports[\s\S]*FOR UPDATE/.test(sql)),
    ).toBe(false);
    expect(h.removeContentOn).toHaveBeenCalledWith(
      h.connection,
      'p-1',
      { reason: 'Spam' },
      'u-mod',
    );
    expect(h.removeOn).not.toHaveBeenCalled();
    expect(h.log).toEqual(['begin', 'commit']);
  });

  it('removes a comment through the comment removal path', async () => {
    const h = harness([
      MODERATOR,
      [REPORT_READ, openReport({ target_type: 'comment', target_id: 'm-1' })],
      [/^SELECT removed_at FROM comments/, [{ removed_at: null }]],
      [
        /LEFT JOIN users reviewer/,
        openReport({
          target_type: 'comment',
          target_id: 'm-1',
          community_status: 'removed',
        }),
      ],
    ]);
    await h.service.remove('garden', 'u-mod', 'r-1', {});
    expect(h.removeOn).toHaveBeenCalledWith(h.connection, 'm-1', {}, 'u-mod');
  });

  it('only closes the reports of content already removed', async () => {
    const h = harness([
      MODERATOR,
      [REPORT_READ, openReport()],
      [/^SELECT removed_at FROM posts/, [{ removed_at: new Date() }]],
      [CLOSE_COMMUNITY_REPORTS_SQL, { affectedRows: 1 }],
      [/LEFT JOIN users reviewer/, openReport({ community_status: 'removed' })],
    ]);
    await h.service.remove('garden', 'u-mod', 'r-1', {});
    expect(h.removeContentOn).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'report_removed',
        metadata: { reports: 1 },
      }),
    );
  });

  it('rolls the removal back when the report was decided concurrently', async () => {
    const h = harness([
      MODERATOR,
      [REPORT_READ, openReport()],
      [/^SELECT removed_at FROM posts/, [{ removed_at: null }]],
      [
        /LEFT JOIN users reviewer/,
        openReport({ community_status: 'approved' }),
      ],
    ]);
    await expect(
      h.service.remove('garden', 'u-mod', 'r-1', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.log).toEqual(['begin', 'rollback']);
  });

  it('refuses content that no longer exists', async () => {
    const h = harness([MODERATOR, [REPORT_READ, openReport()]]);
    await expect(
      h.service.remove('garden', 'u-mod', 'r-1', {}),
    ).rejects.toThrow('The content no longer exists');
  });
});

describe('closeCommunityReports', () => {
  it('logs only when it closed something', async () => {
    const record = jest.fn<(...args: unknown[]) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const connection = {
      execute: jest.fn(() => Promise.resolve([{ affectedRows: 0 }, []])),
    };
    const closed = await closeCommunityReports(
      connection as never,
      { record },
      {
        status: 'removed',
        actorId: 'u',
        communityId: 'c',
        targetType: 'post',
        targetId: 'p',
      },
    );
    expect(closed).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('ReportsService and the community level', () => {
  function reportsHarness(decided: boolean) {
    const statements: string[] = [];
    const connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
      execute: (sql: string) => {
        statements.push(sql);
        if (sql.includes("community_status IN ('approved', 'removed')")) {
          return Promise.resolve([decided ? [{ id: 'old' }] : [], []]);
        }
        if (sql.startsWith('SELECT created_at')) {
          return Promise.resolve([[{ created_at: new Date() }], []]);
        }
        return Promise.resolve([
          sql.startsWith('INSERT') ? { affectedRows: 1 } : [],
          [],
        ]);
      },
    };
    const pool = {
      execute: (sql: string) =>
        Promise.resolve([
          sql.startsWith('SELECT author_id, community_id FROM posts')
            ? [{ author_id: 'author', community_id: 'c-1' }]
            : [],
          [],
        ]),
      getConnection: () => Promise.resolve(connection),
    } as unknown as Pool;
    return { service: new ReportsService(pool), statements };
  }

  // The administrators may have closed theirs already; the moderators'
  // decision alone keeps the same reporter from reopening the entry.
  it('refuses a report by a reporter whose earlier report the moderators decided', async () => {
    const { service, statements } = reportsHarness(true);
    await expect(
      service.create(
        { target_type: 'post', target: 'p-1', reason: 'spam' } as never,
        'reporter',
      ),
    ).rejects.toThrow(
      "The community's moderators have already reviewed your report",
    );
    expect(statements.some((sql) => sql.startsWith('INSERT'))).toBe(false);
  });

  it('accepts one otherwise, routed to the community and open there', async () => {
    const { service } = reportsHarness(false);
    await expect(
      service.create(
        { target_type: 'post', target: 'p-1', reason: 'spam' } as never,
        'reporter',
      ),
    ).resolves.toMatchObject({ status: 'open' });
  });
});
