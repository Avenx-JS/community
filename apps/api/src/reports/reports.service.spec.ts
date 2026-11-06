import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import type { Pool } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportsService } from './reports.service';

const REPORTER = 'reporter-id';
const AUTHOR = 'author-id';

describe('ReportsService', () => {
  let service: ReportsService;
  let poolCalls: Array<{ sql: string; values: unknown[] }>;
  let connectionCalls: Array<{ sql: string; values: unknown[] }>;
  let existingReports: Array<{ id: string }>;
  let users: Record<string, string>;
  let posts: Record<string, string>;
  let comments: Record<string, string>;
  let communities: Record<string, { id: string; creator_id: string }>;
  let throwOnInsert: boolean;
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };

  beforeEach(async () => {
    poolCalls = [];
    connectionCalls = [];
    existingReports = [];
    users = { reported_user: 'reported-id', reporter_user: REPORTER };
    posts = { 'post-1': AUTHOR, 'post-2': AUTHOR, 'own-post': REPORTER };
    comments = { 'comment-1': AUTHOR, 'own-comment': REPORTER };
    communities = {
      'some-community': { id: 'community-id', creator_id: AUTHOR },
      'own-community': { id: 'own-community-id', creator_id: REPORTER },
    };
    throwOnInsert = false;
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        connectionCalls.push({ sql, values });
        if (sql.startsWith('SELECT id FROM user_reports')) {
          return Promise.resolve([existingReports, []]);
        }
        if (sql.startsWith('INSERT INTO user_reports')) {
          if (throwOnInsert) {
            return Promise.reject(new Error('insert failed'));
          }
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('SELECT created_at FROM user_reports')) {
          return Promise.resolve([
            [{ created_at: '2026-10-25T10:00:00.000Z' }],
            [],
          ]);
        }
        return Promise.resolve([[], []]);
      },
    };
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        poolCalls.push({ sql, values });
        const key = values[0] as string;
        if (sql.startsWith('SELECT id, username FROM users')) {
          return Promise.resolve([
            key in users ? [{ id: users[key], username: key }] : [],
            [],
          ]);
        }
        if (sql.startsWith('SELECT author_id FROM posts')) {
          return Promise.resolve([
            key in posts ? [{ author_id: posts[key] }] : [],
            [],
          ]);
        }
        if (sql.startsWith('SELECT author_id FROM comments')) {
          return Promise.resolve([
            key in comments ? [{ author_id: comments[key] }] : [],
            [],
          ]);
        }
        if (sql.startsWith('SELECT id, creator_id FROM communities')) {
          return Promise.resolve([
            key in communities ? [communities[key]] : [],
            [],
          ]);
        }
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      },
      getConnection: () => Promise.resolve(connection),
    };
    // No CommunityRuleAcceptanceService is provided, so the service cannot
    // consult one: reporting must never depend on accepting a community's rules.
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReportsService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
  });

  const report = (
    target_type: CreateReportDto['target_type'],
    target: string,
    overrides: Partial<CreateReportDto> = {},
  ): CreateReportDto => ({ target_type, target, reason: 'spam', ...overrides });
  const inserted = () =>
    connectionCalls.find((call) =>
      call.sql.startsWith('INSERT INTO user_reports'),
    )?.values;
  const duplicateCheck = () =>
    connectionCalls.find((call) =>
      call.sql.startsWith('SELECT id FROM user_reports'),
    );

  describe('column assignment per target type', () => {
    it.each([
      {
        type: 'user' as const,
        target: 'reported_user',
        targetId: 'reported-id',
        reported: 'reported-id',
        author: null,
        username: 'reported_user',
      },
      {
        type: 'post' as const,
        target: 'post-1',
        targetId: 'post-1',
        reported: AUTHOR,
        author: AUTHOR,
        username: null,
      },
      {
        type: 'comment' as const,
        target: 'comment-1',
        targetId: 'comment-1',
        reported: AUTHOR,
        author: AUTHOR,
        username: null,
      },
      {
        type: 'community' as const,
        target: 'some-community',
        targetId: 'community-id',
        reported: null,
        author: null,
        username: null,
      },
    ])(
      'stores a $type target and returns only the receipt',
      async ({ type, target, targetId, reported, author, username }) => {
        const response = await service.create(report(type, target), REPORTER);

        expect(response).toEqual({
          id: expect.any(String) as unknown,
          target_type: type,
          target,
          reported_username: username,
          reason: 'spam',
          status: 'open',
          created_at: '2026-10-25T10:00:00.000Z',
        });
        expect(inserted()).toEqual([
          response.id,
          REPORTER,
          reported,
          'spam',
          null,
          null,
          null,
          type,
          targetId,
          author,
        ]);
        expect(duplicateCheck()?.values).toEqual([
          REPORTER,
          type,
          targetId,
          null,
          null,
        ]);
        expect(connection.commit).toHaveBeenCalled();
        expect(connection.release).toHaveBeenCalled();
      },
    );

    it('never names the author in the response to a content report', async () => {
      const response = await service.create(report('post', 'post-1'), REPORTER);
      expect(JSON.stringify(response)).not.toContain(AUTHOR);
      expect(response.reported_username).toBeNull();
    });

    it('never returns the community’s internal id', async () => {
      const response = await service.create(
        report('community', 'some-community'),
        REPORTER,
      );
      expect(JSON.stringify(response)).not.toContain('community-id');
    });
  });

  describe('per-type format validation', () => {
    it.each([
      ['user', 'ab'],
      ['user', 'has-hyphen'],
      ['post', 'p'.repeat(37)],
      ['comment', 'c'.repeat(37)],
    ] as const)(
      'refuses %s target %s with 400 before any query',
      async (type, target) => {
        await expect(
          service.create(report(type, target), REPORTER),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(poolCalls).toHaveLength(0);
      },
    );

    it.each([
      ['community', 'with-hyphen'],
      ['community', 'x'],
      ['post', 'p'.repeat(36)],
    ] as const)('accepts %s target %s', async (type, target) => {
      communities.x = { id: 'x-id', creator_id: AUTHOR };
      communities['with-hyphen'] = { id: 'h-id', creator_id: AUTHOR };
      posts['p'.repeat(36)] = AUTHOR;
      await expect(
        service.create(report(type, target), REPORTER),
      ).resolves.toMatchObject({ status: 'open' });
    });
  });

  describe('refusals', () => {
    it.each([
      ['user', 'nobody_here', 'User not found'],
      ['post', 'missing-post', 'Post not found'],
      ['comment', 'missing-comment', 'Comment not found'],
      ['community', 'missing-community', 'Community not found'],
    ] as const)(
      'answers an unknown %s with 404, opening no transaction',
      async (type, target, message) => {
        const attempt = service.create(report(type, target), REPORTER);
        await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
        await expect(attempt).rejects.toThrow(message);
        expect(connection.beginTransaction).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['user', 'reporter_user', 'Invalid report target'],
      ['post', 'own-post', 'You cannot report your own post'],
      ['comment', 'own-comment', 'You cannot report your own comment'],
      [
        'community',
        'own-community',
        'You cannot report a community you created',
      ],
    ] as const)(
      'answers your own %s with 400 and a clear message',
      async (type, target, message) => {
        const attempt = service.create(report(type, target), REPORTER);
        await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
        await expect(attempt).rejects.toThrow(message);
        expect(connection.beginTransaction).not.toHaveBeenCalled();
      },
    );

    it('rejects reasons outside the shared schema vocabulary', async () => {
      await expect(
        service.create(
          {
            ...report('user', 'reported_user'),
            reason: 'unknown',
          } as unknown as CreateReportDto,
          REPORTER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(poolCalls).toHaveLength(0);
    });
  });

  // A moderator having already acted is no reason to discard a report.
  it('does not filter resolution on removed, deleted or suspended state', async () => {
    await service.create(report('post', 'post-1'), REPORTER);
    await service.create(report('comment', 'comment-1'), REPORTER);
    await service.create(report('community', 'some-community'), REPORTER);
    for (const { sql } of poolCalls) {
      expect(sql).not.toMatch(/removed_at|deleted_at|suspended_at/);
    }
  });

  describe('context on a user target', () => {
    it('must exist', async () => {
      await expect(
        service.create(
          report('user', 'reported_user', {
            context_type: 'post',
            context_id: 'missing-post',
          }),
          REPORTER,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(connection.beginTransaction).not.toHaveBeenCalled();
    });

    it('must belong to the reported user', async () => {
      await expect(
        service.create(
          report('user', 'reported_user', {
            context_type: 'comment',
            context_id: 'comment-1',
          }),
          REPORTER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(connection.beginTransaction).not.toHaveBeenCalled();
    });

    it('is stored, and used in the null-safe duplicate key', async () => {
      posts['their-post'] = 'reported-id';
      await service.create(
        report('user', 'reported_user', {
          context_type: 'post',
          context_id: 'their-post',
        }),
        REPORTER,
      );
      expect(duplicateCheck()?.sql).toContain(
        'context_type <=> ? AND context_id <=> ?',
      );
      expect(duplicateCheck()?.values).toEqual([
        REPORTER,
        'user',
        'reported-id',
        'post',
        'their-post',
      ]);
      expect(inserted()?.slice(5, 7)).toEqual(['post', 'their-post']);
    });

    // The DTO refuses this; the service must still never store it.
    it('is never stored for another target type', async () => {
      await service.create(
        report('post', 'post-1', {
          context_type: 'comment',
          context_id: 'comment-1',
        }),
        REPORTER,
      );
      expect(inserted()?.slice(5, 7)).toEqual([null, null]);
    });
  });

  describe('the duplicate check', () => {
    // A store that applies the duplicate query's key to what was inserted.
    let stored: unknown[][];

    beforeEach(() => {
      stored = [];
      const execute = connection.execute;
      connection.execute = (sql, values) => {
        if (sql.startsWith('INSERT INTO user_reports')) {
          // reporter, target_type, target_id, context_type, context_id
          stored.push([values[1], values[7], values[8], values[5], values[6]]);
        }
        if (sql.startsWith('SELECT id FROM user_reports')) {
          connectionCalls.push({ sql, values });
          const key = JSON.stringify(values);
          return Promise.resolve([
            stored
              .filter((row) => JSON.stringify(row) === key)
              .map(() => ({ id: 'active-report' })),
            [],
          ]);
        }
        return execute(sql, values);
      };
    });

    it('accepts two posts by one author, refusing a second report of either', async () => {
      await service.create(report('post', 'post-1'), REPORTER);
      await service.create(report('post', 'post-2'), REPORTER);
      expect(stored).toHaveLength(2);

      await expect(
        service.create(report('post', 'post-1'), REPORTER),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(stored).toHaveLength(2);
    });

    it('keeps a post and a comment with the same id apart', async () => {
      posts.same = AUTHOR;
      comments.same = AUTHOR;
      await service.create(report('post', 'same'), REPORTER);
      await service.create(report('comment', 'same'), REPORTER);
      expect(stored).toHaveLength(2);
    });

    it('keeps a user report and a report of that user’s post apart', async () => {
      users.author_user = AUTHOR;
      await service.create(report('user', 'author_user'), REPORTER);
      await service.create(report('post', 'post-1'), REPORTER);
      expect(stored).toHaveLength(2);
    });

    it('refuses a second report of one community', async () => {
      await service.create(report('community', 'some-community'), REPORTER);
      await expect(
        service.create(report('community', 'some-community'), REPORTER),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // Unchanged for user targets: other evidence is a new report.
    it('still treats a user report with different evidence as new', async () => {
      posts.first = 'reported-id';
      posts.second = 'reported-id';
      const withEvidence = (id: string) =>
        report('user', 'reported_user', {
          context_type: 'post',
          context_id: id,
        });
      await service.create(withEvidence('first'), REPORTER);
      await service.create(withEvidence('second'), REPORTER);
      await service.create(report('user', 'reported_user'), REPORTER);
      expect(stored).toHaveLength(3);

      await expect(
        service.create(withEvidence('first'), REPORTER),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.create(report('user', 'reported_user'), REPORTER),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('only looks at active reports', async () => {
      await service.create(report('post', 'post-1'), REPORTER);
      expect(duplicateCheck()?.sql).toContain(
        "status IN ('open', 'under_review')",
      );
    });
  });

  it('conflicts with an active duplicate and rolls back without inserting', async () => {
    existingReports = [{ id: 'existing-report' }];

    await expect(
      service.create(report('post', 'post-1'), REPORTER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(connection.rollback).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
    expect(inserted()).toBeUndefined();
  });

  it('rolls back and releases the connection after an insert failure', async () => {
    throwOnInsert = true;

    await expect(
      service.create(report('post', 'post-1'), REPORTER),
    ).rejects.toThrow('insert failed');
    expect(connection.rollback).toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalled();
  });

  // Models what InnoDB does for this flow: the reporter's row lock is held to
  // the end of the transaction and an uncommitted insert is invisible to others.
  // The competing request starts between the first one's check and its insert;
  // without the lock it would see no duplicate, and both would be stored.
  describe('two concurrent submissions for one target', () => {
    it('yields exactly one success and one 409', async () => {
      const committed: string[] = [];
      let lock: Promise<void> = Promise.resolve();
      let competing: Promise<unknown> | undefined;
      let checked = false;

      const getConnection = () => {
        let release: () => void = () => undefined;
        let pending: string | undefined;
        const finish = () => {
          pending = undefined;
          release();
          return Promise.resolve();
        };
        return Promise.resolve({
          beginTransaction: () => Promise.resolve(),
          commit: () => {
            if (pending) {
              committed.push(pending);
            }
            return finish();
          },
          rollback: finish,
          release: () => undefined,
          execute: async (sql: string, values: unknown[]) => {
            if (sql.startsWith('SELECT id FROM users')) {
              const previous = lock;
              lock = new Promise((resolve) => {
                release = resolve;
              });
              await previous;
              return [[], []];
            }
            if (sql.startsWith('SELECT id FROM user_reports')) {
              const rows = committed
                .filter((target) => target === values[2])
                .map(() => ({ id: 'existing' }));
              if (!checked) {
                checked = true;
                competing = reports
                  .create(report('post', 'post-1'), REPORTER)
                  .catch((error: unknown) => error);
              }
              return [rows, []];
            }
            if (sql.startsWith('INSERT INTO user_reports')) {
              pending = values[8] as string;
              return [{ affectedRows: 1 }, []];
            }
            return [[{ created_at: '2026-10-25T10:00:00.000Z' }], []];
          },
        });
      };
      const reports = new ReportsService({
        getConnection,
        execute: () => Promise.resolve([[{ author_id: AUTHOR }], []]),
      } as unknown as Pool);

      await expect(
        reports.create(report('post', 'post-1'), REPORTER),
      ).resolves.toMatchObject({ status: 'open' });
      await expect(competing).resolves.toBeInstanceOf(ConflictException);
      expect(committed).toEqual(['post-1']);
    });
  });
});
