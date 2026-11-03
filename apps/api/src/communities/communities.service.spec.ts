import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import type { PoolConnection } from 'mysql2/promise';
import { CommunitiesService } from './communities.service';
import { CommunityModerationLogService } from './community-moderation-log.service';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';

describe('CommunitiesService', () => {
  let service: CommunitiesService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let results: unknown[][];
  let ruleAcceptance: { assertAcceptedOrThrow: jest.Mock };
  let moderationLog: { record: jest.Mock };

  beforeEach(async () => {
    queries = [];
    results = [];
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return Promise.resolve([results.shift() ?? [], []]);
      },
    };
    // Every community's rules count as accepted unless a test says otherwise.
    ruleAcceptance = {
      assertAcceptedOrThrow: jest.fn().mockResolvedValue(undefined),
    };
    moderationLog = { record: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunitiesService,
        { provide: MYSQL_POOL, useValue: pool },
        { provide: CommunityRuleAcceptanceService, useValue: ruleAcceptance },
        { provide: CommunityModerationLogService, useValue: moderationLog },
      ],
    }).compile();
    service = module.get<CommunitiesService>(CommunitiesService);
  });

  it('returns a paginated list using a stable order and matching count', async () => {
    results = [
      [
        {
          id: 'community-1',
          creator_id: 'user-1',
          name: 'gardening',
          description: null,
          created_at: new Date('2026-10-20T12:00:00.000Z'),
        },
      ],
      [{ total: 3 }],
    ];

    const result = await service.findAll({
      search: 'garden',
      page: 2,
      limit: 1,
    });

    expect(result).toMatchObject({ page: 2, limit: 1, total: 3 });
    expect(result.items[0]).toMatchObject({
      id: 'community-1',
      name: 'gardening',
      created_at: '2026-10-20T12:00:00.000Z',
    });
    expect(queries[0].sql).toContain(
      'ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    );
    expect(queries[0].values).toEqual(['%garden%', '%garden%', 1, 1]);
    expect(queries[1].values).toEqual(['%garden%', '%garden%']);
  });

  it('escapes LIKE wildcards in community search through the shared helper', async () => {
    results = [[], [{ total: 0 }]];

    await service.findAll({ search: '100%_safe=' });

    expect(queries[0].values).toEqual([
      '%100=%=_safe==%',
      '%100=%=_safe==%',
      20,
      0,
    ]);
  });

  it('persists the authenticated creator and returns the created community', async () => {
    results = [
      [],
      [
        {
          id: 'community-created',
          creator_id: 'authenticated-user',
          name: 'gardening',
          description: null,
          created_at: new Date('2026-10-20T12:00:00.000Z'),
        },
      ],
    ];

    const result = await service.create(
      { name: ' gardening ' },
      'authenticated-user',
    );

    expect(queries[0].sql).toContain(
      'INSERT INTO communities (id, creator_id, name, description) VALUES (?, ?, ?, ?)',
    );
    expect(queries[0].values).toEqual([
      expect.any(String),
      'authenticated-user',
      'gardening',
      null,
    ]);
    expect(queries[1].values).toEqual([queries[0].values[0]]);
    expect(result).toMatchObject({
      id: 'community-created',
      creator_id: 'authenticated-user',
      name: 'gardening',
    });
  });

  it('never reads, writes or returns the dropped rules column', async () => {
    // A row carrying a stray rules value, as an un-migrated database would
    // return to SELECT *, proves the DTO maps only its documented fields.
    const row = {
      id: 'community-1',
      creator_id: 'user-1',
      name: 'gardening',
      description: null,
      rules: 'stale legacy text',
      created_at: new Date('2026-10-20T12:00:00.000Z'),
    };
    results = [[row], [{ total: 1 }], [], [row], [row]];

    const listed = await service.findAll({});
    const created = await service.create({ name: 'gardening' }, 'user-1');
    const found = await service.findOne('gardening');

    for (const community of [listed.items[0], created, found]) {
      expect(Object.keys(community).sort()).toEqual([
        'created_at',
        'creator_id',
        'description',
        'id',
        'name',
      ]);
    }
    for (const { sql } of queries) {
      expect(sql).not.toMatch(/\brules\b/);
    }
  });

  it('maps duplicate names to conflict and missing details to not found', async () => {
    const duplicatePool = {
      execute: () =>
        Promise.reject(
          Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' }),
        ),
    };
    const duplicateModule = await Test.createTestingModule({
      providers: [
        CommunitiesService,
        { provide: MYSQL_POOL, useValue: duplicatePool },
        { provide: CommunityRuleAcceptanceService, useValue: ruleAcceptance },
        { provide: CommunityModerationLogService, useValue: moderationLog },
      ],
    }).compile();
    const duplicateService = duplicateModule.get(CommunitiesService);

    await expect(
      duplicateService.create({ name: 'taken' }, 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);

    results = [[]];
    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lets only the community creator assign and remove moderators', async () => {
    results = [
      [{ id: 'community-1', creator_id: 'creator' }],
      [{ id: 'mod' }],
      [{ user_id: 'mod' }],
      [],
    ];
    await service.addModerator('gardening', 'moderator', 'creator');
    expect(queries[3].sql).toContain('INSERT INTO community_moderators');
    expect(queries[3].values).toEqual(['community-1', 'mod', 'creator']);

    results = [[{ id: 'community-1', creator_id: 'creator' }], []];
    await service.removeModerator('gardening', 'moderator', 'creator');
    expect(queries[5].sql).toContain('DELETE FROM community_moderators');

    results = [[{ id: 'community-1', creator_id: 'creator' }]];
    await expect(
      service.addModerator('gardening', 'moderator', 'ordinary-member'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not appoint a non-member as moderator', async () => {
    results = [
      [{ id: 'community-1', creator_id: 'creator' }],
      [{ id: 'user-2' }],
      [],
    ];
    await expect(
      service.addModerator('gardening', 'non_member', 'creator'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      queries.some((query) =>
        query.sql.includes('INSERT INTO community_moderators'),
      ),
    ).toBe(false);
  });

  it('lists only the given user subscriptions, newest first, with paging', async () => {
    results = [
      [
        {
          id: 'community-1',
          name: 'gardening',
          description: 'Growing plants',
          subscribed_at: new Date('2026-10-21T09:00:00.000Z'),
        },
      ],
      [{ total: 7 }],
    ];

    const result = await service.listSubscriptions('user-1', {
      page: 3,
      limit: 2,
    });

    expect(result).toEqual({
      items: [
        {
          community: {
            id: 'community-1',
            name: 'gardening',
            description: 'Growing plants',
          },
          subscribed_at: '2026-10-21T09:00:00.000Z',
        },
      ],
      page: 3,
      limit: 2,
      total: 7,
    });
    expect(queries[0].sql).toContain('WHERE s.user_id = ?');
    expect(queries[0].sql).toContain(
      'ORDER BY s.created_at DESC, s.community_id DESC LIMIT ? OFFSET ?',
    );
    expect(queries[0].values).toEqual(['user-1', 2, 4]);
    expect(queries[1].sql).toContain(
      'WHERE s.user_id = ? AND c.deleted_at IS NULL',
    );
    expect(queries[1].values).toEqual(['user-1']);
  });

  it('returns an empty subscription page with defaults', async () => {
    results = [[], [{ total: 0 }]];

    await expect(service.listSubscriptions('user-1', {})).resolves.toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
    });
    expect(queries[0].values).toEqual(['user-1', 20, 0]);
  });

  it('reports whether the user is subscribed to a community', async () => {
    results = [
      [{ id: 'community-1' }],
      [{ created_at: new Date('2026-10-21T09:00:00.000Z') }],
    ];
    await expect(
      service.getSubscription('gardening', 'user-1'),
    ).resolves.toEqual({
      subscribed: true,
      subscribed_at: '2026-10-21T09:00:00.000Z',
    });
    expect(queries[1].values).toEqual(['user-1', 'community-1']);

    results = [[{ id: 'community-1' }], []];
    await expect(
      service.getSubscription('gardening', 'user-1'),
    ).resolves.toEqual({ subscribed: false, subscribed_at: null });
  });

  it('returns not found for the subscription of an unknown community', async () => {
    results = [[]];

    await expect(
      service.getSubscription('unknown', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(queries).toHaveLength(1);
  });

  it('excludes deleted communities from every community read', async () => {
    results = [[], [{ total: 0 }]];
    await service.findAll({ search: 'garden' });
    expect(queries[0].sql).toContain(
      "WHERE deleted_at IS NULL AND (LOWER(name) LIKE LOWER(?) ESCAPE '=' OR LOWER(description) LIKE LOWER(?) ESCAPE '=')",
    );
    expect(queries[1].sql).toContain('WHERE deleted_at IS NULL AND (');

    queries = [];
    results = [[], [{ total: 0 }]];
    await service.findAll({});
    expect(queries[0].sql).toContain(
      'FROM communities WHERE deleted_at IS NULL ORDER BY',
    );
    expect(queries[1].sql).toBe(
      'SELECT COUNT(*) AS total FROM communities WHERE deleted_at IS NULL',
    );

    queries = [];
    results = [[], [{ total: 0 }]];
    await service.listSubscriptions('user-1', {});
    for (const { sql } of queries) {
      expect(sql).toContain('c.deleted_at IS NULL');
    }

    const lookups: Array<() => Promise<unknown>> = [
      () => service.findOne('gardening'),
      () => service.subscribe('gardening', 'user-1'),
      () => service.getSubscription('gardening', 'user-1'),
      () => service.unsubscribe('gardening', 'user-1'),
      () => service.addModerator('gardening', 'member', 'creator'),
      () => service.removeModerator('gardening', 'member', 'creator'),
    ];
    for (const lookup of lookups) {
      queries = [];
      results = [[]];
      await expect(lookup()).rejects.toBeInstanceOf(NotFoundException);
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain('name = ? AND deleted_at IS NULL');
    }
  });

  describe('update and remove', () => {
    let statements: Array<{ sql: string; values: unknown[] }>;
    let answers: unknown[][];
    let connection: {
      beginTransaction: jest.Mock;
      commit: jest.Mock;
      rollback: jest.Mock;
      release: jest.Mock;
      execute: jest.Mock;
    };
    let transactional: CommunitiesService;

    const community = { id: 'community-1', creator_id: 'creator' };
    const updated = {
      id: 'community-1',
      creator_id: 'creator',
      name: 'gardening',
      description: 'Fixed typo',
      created_at: new Date('2026-10-20T12:00:00.000Z'),
    };

    beforeEach(async () => {
      statements = [];
      answers = [];
      connection = {
        beginTransaction: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
        release: jest.fn(),
        execute: jest.fn((sql: string, values: unknown[]) => {
          statements.push({ sql, values });
          return Promise.resolve([answers.shift() ?? [], []]);
        }),
      };
      const module = await Test.createTestingModule({
        providers: [
          CommunitiesService,
          {
            provide: MYSQL_POOL,
            useValue: { getConnection: () => Promise.resolve(connection) },
          },
          { provide: CommunityRuleAcceptanceService, useValue: ruleAcceptance },
          { provide: CommunityModerationLogService, useValue: moderationLog },
        ],
      }).compile();
      transactional = module.get(CommunitiesService);
    });

    it('updates the description with a dynamic SET, logs it in the transaction and returns the DTO', async () => {
      answers = [[community], [{ affectedRows: 1 }], [updated]];

      await expect(
        transactional.update(
          'gardening',
          { description: 'Fixed typo' },
          'creator',
        ),
      ).resolves.toEqual({
        ...updated,
        created_at: '2026-10-20T12:00:00.000Z',
      });

      expect(statements[0].sql).toBe(
        'SELECT id, creator_id FROM communities WHERE name = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
      );
      expect(statements[1]).toEqual({
        sql: 'UPDATE communities SET description = ? WHERE id = ?',
        values: ['Fixed typo', 'community-1'],
      });
      expect(
        statements.some(({ sql }) => /\bname\s*=/.test(sql.split('WHERE')[0])),
      ).toBe(false);
      expect(moderationLog.record).toHaveBeenCalledWith(connection, {
        actorId: 'creator',
        communityId: 'community-1',
        action: 'community_updated',
        targetType: 'community',
        targetId: 'community-1',
        metadata: { fields: 'description' },
      });
      expect(connection.commit).toHaveBeenCalledTimes(1);
      expect(connection.rollback).not.toHaveBeenCalled();
      expect(connection.release).toHaveBeenCalledTimes(1);
    });

    it('stores an emptied description as NULL', async () => {
      answers = [
        [community],
        [{ affectedRows: 1 }],
        [{ ...updated, description: null }],
      ];

      await transactional.update('gardening', { description: '' }, 'creator');

      expect(statements[1].values).toEqual([null, 'community-1']);
    });

    it('refuses an update with no field before touching the database', async () => {
      await expect(
        transactional.update('gardening', {}, 'creator'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(connection.beginTransaction).not.toHaveBeenCalled();
    });

    it.each([
      [
        'update',
        (s: CommunitiesService, actor: string) =>
          s.update('gardening', { description: 'x' }, actor),
      ],
      [
        'remove',
        (s: CommunitiesService, actor: string) =>
          s.remove('gardening', 'gardening', actor),
      ],
    ] as const)(
      '%s answers 404 for an unknown or deleted community before 403, and 403 for anyone but the creator',
      async (_name, call) => {
        answers = [[]];
        await expect(call(transactional, 'moderator')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(statements).toHaveLength(1);
        expect(statements[0].sql).toContain('deleted_at IS NULL');
        expect(statements[0].sql).toContain('FOR UPDATE');

        answers = [[community]];
        await expect(call(transactional, 'moderator')).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(statements).toHaveLength(2);
        expect(moderationLog.record).not.toHaveBeenCalled();
        expect(connection.commit).not.toHaveBeenCalled();
        expect(connection.rollback).toHaveBeenCalledTimes(2);
        expect(connection.release).toHaveBeenCalledTimes(2);
      },
    );

    it('soft-deletes under a row lock and logs the deletion in the transaction', async () => {
      answers = [[community], [{ affectedRows: 1 }]];

      await transactional.remove('gardening', 'gardening', 'creator');

      expect(statements).toHaveLength(2);
      expect(statements[0].sql).toBe(
        'SELECT id, creator_id FROM communities WHERE name = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
      );
      expect(statements[1]).toEqual({
        sql: 'UPDATE communities SET deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE id = ?',
        values: ['creator', 'community-1'],
      });
      expect(statements.some(({ sql }) => /^\s*DELETE/i.test(sql))).toBe(false);
      expect(moderationLog.record).toHaveBeenCalledWith(connection, {
        actorId: 'creator',
        communityId: 'community-1',
        action: 'community_deleted',
        targetType: 'community',
        targetId: 'community-1',
      });
      expect(connection.commit).toHaveBeenCalledTimes(1);
      expect(connection.release).toHaveBeenCalledTimes(1);
    });

    it.each(['Gardening', 'gardening ', '', 'other'])(
      'refuses the mismatched confirmation %p without touching the database',
      async (confirmation) => {
        await expect(
          transactional.remove('gardening', confirmation, 'creator'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(connection.beginTransaction).not.toHaveBeenCalled();
        expect(statements).toHaveLength(0);
      },
    );

    it.each([
      [
        'update',
        (s: CommunitiesService) =>
          s.update('gardening', { description: 'x' }, 'creator'),
      ],
      [
        'remove',
        (s: CommunitiesService) =>
          s.remove('gardening', 'gardening', 'creator'),
      ],
    ] as const)(
      '%s rolls back and releases when the log write fails',
      async (_name, call) => {
        answers = [[community], [{ affectedRows: 1 }]];
        moderationLog.record.mockRejectedValueOnce(new Error('log failed'));

        await expect(call(transactional)).rejects.toThrow('log failed');
        expect(connection.commit).not.toHaveBeenCalled();
        expect(connection.rollback).toHaveBeenCalledTimes(1);
        expect(connection.release).toHaveBeenCalledTimes(1);
      },
    );

    it('releases the connection even when beginning the transaction fails', async () => {
      connection.beginTransaction.mockRejectedValueOnce(new Error('down'));

      await expect(
        transactional.remove('gardening', 'gardening', 'creator'),
      ).rejects.toThrow('down');
      expect(connection.rollback).not.toHaveBeenCalled();
      expect(connection.release).toHaveBeenCalledTimes(1);
    });

    // Keeps the type import meaningful: record receives the connection.
    it('passes its own connection, not the pool, to the log', async () => {
      answers = [[community], [{ affectedRows: 1 }]];
      await transactional.remove('gardening', 'gardening', 'creator');
      const [passed] = moderationLog.record.mock.calls[0] as [PoolConnection];
      expect(passed).toBe(connection);
    });
  });
});
