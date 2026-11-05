import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import type { PoolConnection } from 'mysql2/promise';
import { canModerateCommunitySql } from '../common/community-moderation';
import { CommunitiesService } from './communities.service';
import { CommunityModerationLogService } from './community-moderation-log.service';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';
import { ListCommunityMembersDto } from './dto/list-community-members.dto';
import { ListCommunityModeratorsDto } from './dto/list-community-moderators.dto';

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

  describe('listModerators', () => {
    const creatorRow = {
      id: 'community-1',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      creator_id: 'creator-id',
      username: 'creator',
      display_name: 'The Creator',
      creator_deleted_at: null,
      // Columns a wider SELECT might return; none may reach the response.
      email: 'creator@example.com',
      role: 'admin',
    };
    const moderatorRow = (n: number) => ({
      username: `mod_${n}`,
      display_name: null,
      since: new Date(Date.UTC(2026, 1, n)),
      user_id: `mod-${n}-id`,
      email: `mod${n}@example.com`,
      last_seen_at: new Date(),
    });

    it('returns the creator separately and pages only appointed moderators', async () => {
      results = [
        [creatorRow],
        [moderatorRow(3), moderatorRow(4)],
        [{ total: '7' }],
      ];

      const result = await service.listModerators('gardening', {
        page: 2,
        limit: 2,
      });

      expect(result).toEqual({
        creator: {
          username: 'creator',
          display_name: 'The Creator',
          role: 'creator',
          since: '2026-01-01T00:00:00.000Z',
        },
        items: [
          {
            username: 'mod_3',
            display_name: null,
            role: 'moderator',
            since: '2026-02-03T00:00:00.000Z',
          },
          {
            username: 'mod_4',
            display_name: null,
            role: 'moderator',
            since: '2026-02-04T00:00:00.000Z',
          },
        ],
        page: 2,
        limit: 2,
        total: 7,
      });
      expect(queries[0].sql).toContain(
        'WHERE c.name = ? AND c.deleted_at IS NULL',
      );
      // The creator is excluded from items and total even if appointed, and
      // so can never be duplicated or pushed to a later page.
      for (const query of queries.slice(1)) {
        expect(query.sql).toContain('m.user_id <> ?');
        expect(query.sql).toContain('u.deleted_at IS NULL');
      }
      expect(queries[1].sql).toContain(
        'ORDER BY m.created_at ASC, m.user_id ASC LIMIT ? OFFSET ?',
      );
      expect(queries[1].values).toEqual(['community-1', 'creator-id', 2, 2]);
      expect(queries[2].values).toEqual(['community-1', 'creator-id']);
      expect(JSON.stringify(result)).not.toMatch(/@|-id|admin|last_seen|email/);
    });

    it('returns the creator and an empty collection with no appointed moderators', async () => {
      results = [[creatorRow], [], [{ total: 0 }]];

      const result = await service.listModerators(
        'gardening',
        new ListCommunityModeratorsDto(),
      );

      expect(result.creator?.username).toBe('creator');
      expect(result).toMatchObject({ items: [], page: 1, limit: 20, total: 0 });
      expect(queries[1].values).toEqual(['community-1', 'creator-id', 20, 0]);
    });

    it('renders a creator whose account was deleted as null without throwing', async () => {
      results = [
        [{ ...creatorRow, creator_deleted_at: new Date() }],
        [],
        [{ total: 0 }],
      ];

      await expect(
        service.listModerators('gardening', new ListCommunityModeratorsDto()),
      ).resolves.toMatchObject({ creator: null });
    });

    it('answers 404 for an unknown or deleted community without listing', async () => {
      results = [[]];

      await expect(
        service.listModerators('missing', new ListCommunityModeratorsDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(queries).toHaveLength(1);
    });
  });

  describe('listMembers', () => {
    const access = (canModerate: number | string) => [
      { id: 'community-1', can_moderate: canModerate },
    ];
    const memberRow = (n: number, isModerator: number | string) => ({
      username: `member_${n}`,
      display_name: n === 1 ? 'Member One' : null,
      subscribed_at: new Date(Date.UTC(2026, 2, n)),
      is_moderator: isModerator,
      email: `m${n}@example.com`,
      role: 'admin',
      user_id: `user-${n}`,
    });

    it('authorizes with the shared moderation predicate in one lookup', async () => {
      results = [access(1), [], [{ total: 0 }]];

      await service.listMembers(
        'gardening',
        'mod-id',
        new ListCommunityMembersDto(),
      );

      expect(queries[0].sql).toContain(canModerateCommunitySql('c.id'));
      expect(queries[0].sql).toContain(
        'WHERE c.name = ? AND c.deleted_at IS NULL',
      );
      expect(queries[0].values).toEqual(['mod-id', 'mod-id', 'gardening']);
    });

    it('answers 404 before any 403, and 403 for anyone who does not moderate', async () => {
      results = [[]];
      await expect(
        service.listMembers(
          'missing',
          'member-id',
          new ListCommunityMembersDto(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(queries).toHaveLength(1);

      for (const denied of [0, '0']) {
        queries = [];
        results = [access(denied)];
        await expect(
          service.listMembers(
            'gardening',
            'member-id',
            new ListCommunityMembersDto(),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(queries).toHaveLength(1);
      }
    });

    it('maps is_moderator from the moderator join and exposes only documented fields', async () => {
      results = [
        access('1'),
        [memberRow(1, 1), memberRow(2, 0)],
        [{ total: 2 }],
      ];

      const result = await service.listMembers(
        'gardening',
        'creator-id',
        new ListCommunityMembersDto(),
      );

      expect(result).toEqual({
        items: [
          {
            username: 'member_1',
            display_name: 'Member One',
            subscribed_at: '2026-03-01T00:00:00.000Z',
            is_moderator: true,
          },
          {
            username: 'member_2',
            display_name: null,
            subscribed_at: '2026-03-02T00:00:00.000Z',
            is_moderator: false,
          },
        ],
        page: 1,
        limit: 20,
        total: 2,
      });
      expect(queries[1].sql).toContain(
        'LEFT JOIN community_moderators m\n         ON m.community_id = s.community_id AND m.user_id = s.user_id',
      );
      // The SELECT list is the boundary: no id, email, last_seen_at or role.
      const selected = queries[1].sql.slice(0, queries[1].sql.indexOf('FROM'));
      expect(selected).not.toMatch(
        /\b(id|user_id|email|role|last_seen_at)\b(?! IS NOT NULL)/,
      );
      expect(selected).toMatch(
        /^SELECT u\.username, u\.display_name, s\.created_at AS subscribed_at,\s+m\.user_id IS NOT NULL AS is_moderator\s*$/,
      );
      expect(JSON.stringify(result)).not.toMatch(/@|admin|user-\d/);
    });

    it.each([
      ['new', 'DESC'],
      ['oldest', 'ASC'],
    ] as const)(
      'orders %s with the user_id tiebreaker and pages by LIMIT/OFFSET',
      async (sort, direction) => {
        results = [access(1), [], [{ total: 0 }]];

        await service.listMembers('gardening', 'creator-id', {
          sort,
          page: 3,
          limit: 25,
        });

        expect(queries[1].sql).toContain(
          `ORDER BY s.created_at ${direction}, s.user_id ${direction} LIMIT ? OFFSET ?`,
        );
        expect(queries[1].values).toEqual(['community-1', 25, 50]);
        expect(queries[2].values).toEqual(['community-1']);
      },
    );

    it('escapes LIKE wildcards in the username search and applies it to the count', async () => {
      results = [access(1), [], [{ total: 0 }]];

      await service.listMembers(
        'gardening',
        'creator-id',
        Object.assign(new ListCommunityMembersDto(), {
          search: ' 100%_mod= ',
        }),
      );

      for (const query of queries.slice(1)) {
        expect(query.sql).toContain(
          "AND LOWER(u.username) LIKE LOWER(?) ESCAPE '='",
        );
        expect(query.values[1]).toBe('%100=%=_mod==%');
      }
    });

    it('excludes deleted accounts from items and total', async () => {
      results = [access(1), [], [{ total: 0 }]];

      await service.listMembers(
        'gardening',
        'creator-id',
        new ListCommunityMembersDto(),
      );

      for (const query of queries.slice(1)) {
        expect(query.sql).toContain(
          's.community_id = ? AND u.deleted_at IS NULL',
        );
      }
    });
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

describe('CommunitiesService.resolveListedId', () => {
  let queries: Array<{ sql: string; values: unknown[] }>;
  let rows: unknown[];
  const service = () =>
    new CommunitiesService(
      {
        execute: (sql: string, values: unknown[]) => {
          queries.push({ sql, values });
          return Promise.resolve([rows, []]);
        },
      } as never,
      {} as CommunityRuleAcceptanceService,
      {} as CommunityModerationLogService,
    );

  beforeEach(() => {
    queries = [];
    rows = [{ id: 'community-1' }];
  });

  it('binds the name and requires the community to be neither deleted nor suspended', async () => {
    await expect(service().resolveListedId('general')).resolves.toBe(
      'community-1',
    );
    expect(queries).toEqual([
      {
        sql: 'SELECT id FROM communities WHERE name = ? AND deleted_at IS NULL AND suspended_at IS NULL LIMIT 1',
        values: ['general'],
      },
    ]);
  });

  it('answers 404 for an unknown, deleted or suspended community', async () => {
    rows = [];
    await expect(service().resolveListedId('gone')).rejects.toThrow(
      new NotFoundException('Community not found'),
    );
  });
});
