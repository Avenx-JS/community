import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunityRuleAcceptanceService } from './community-rule-acceptance.service';
import { hashCommunityRules } from './community-rules-hash';
import {
  canPublishCommunityRules,
  CommunityRulesService,
} from './community-rules.service';

type Handler = (sql: string, values: unknown[]) => unknown;

describe('CommunityRulesService', () => {
  let service: CommunityRulesService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let results: unknown[];
  let events: string[];

  const community = { id: 'community-1', creator_id: 'creator' };
  const publishedAt = new Date('2026-10-22T08:00:00.000Z');
  const kind = { title: 'Be kind', body: 'No insults.' };
  const spam = { title: 'No spam', body: null };

  const currentDocument = (
    items: Array<{ title: string; body: string | null }>,
    version = 1,
  ) => ({
    id: `document-${version}`,
    version,
    content_hash: hashCommunityRules(
      items.map((item, index) => ({ ...item, position: index + 1 })),
    ),
    published_at: publishedAt,
  });

  // Each query takes the next queued result; a function result runs against
  // the query, so a test can fail or observe a specific statement.
  const execute = (sql: string, values: unknown[]) => {
    queries.push({ sql, values });
    const next = results.shift();
    const value =
      typeof next === 'function' ? (next as Handler)(sql, values) : next;
    if (value instanceof Error) {
      return Promise.reject(value);
    }
    return Promise.resolve([value ?? [], []]);
  };

  const writes = () =>
    queries.filter((query) => query.sql.trimStart().startsWith('INSERT'));

  beforeEach(async () => {
    queries = [];
    results = [];
    events = [];
    const connection = {
      execute,
      beginTransaction: () => {
        events.push('begin');
        return Promise.resolve();
      },
      commit: () => {
        events.push('commit');
        return Promise.resolve();
      },
      rollback: () => {
        events.push('rollback');
        return Promise.resolve();
      },
      release: () => {
        events.push('release');
      },
    };
    const pool = {
      execute,
      getConnection: () => Promise.resolve(connection),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityRulesService,
        CommunityRuleAcceptanceService,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();
    service = module.get(CommunityRulesService);
  });

  describe('publish', () => {
    it('inserts the next version with positions from the array index', async () => {
      results = [
        [community],
        [currentDocument([kind], 2)],
        { affectedRows: 1 },
        { affectedRows: 2 },
        [{ published_at: publishedAt }],
      ];

      const result = await service.publish(
        'gardening',
        { items: [spam, kind] },
        'creator',
      );

      expect(result).toEqual({
        version: 3,
        published_at: '2026-10-22T08:00:00.000Z',
        items: [
          { position: 1, title: 'No spam', body: null },
          { position: 2, title: 'Be kind', body: 'No insults.' },
        ],
      });
      expect(queries[0].sql).toContain('FROM communities WHERE name = ?');
      expect(queries[0].sql).toMatch(/FOR UPDATE$/);
      expect(queries[1].sql).toContain('ORDER BY version DESC');

      const [document, rules] = writes();
      expect(document.sql).toContain('INSERT INTO community_rule_documents');
      expect(document.values).toEqual([
        expect.any(String),
        'community-1',
        3,
        hashCommunityRules(result.items),
        'creator',
      ]);
      expect(rules.sql).toContain('INSERT INTO community_rules');
      expect(rules.values).toEqual([
        expect.any(String),
        document.values[0],
        1,
        'No spam',
        null,
        expect.any(String),
        document.values[0],
        2,
        'Be kind',
        'No insults.',
      ]);
      expect(events).toEqual(['begin', 'commit', 'release']);
    });

    it('starts at version 1 for a community without rules', async () => {
      results = [
        [community],
        [],
        { affectedRows: 1 },
        { affectedRows: 1 },
        [{ published_at: publishedAt }],
      ];

      const result = await service.publish(
        'gardening',
        { items: [kind] },
        'creator',
      );

      expect(result.version).toBe(1);
      expect(writes()[0].values[2]).toBe(1);
    });

    it('returns the current version and writes nothing when the hash is unchanged', async () => {
      results = [
        [community],
        [currentDocument([kind, spam], 4)],
        [
          { position: 1, ...kind },
          { position: 2, ...spam },
        ],
      ];

      const result = await service.publish(
        'gardening',
        { items: [kind, spam] },
        'creator',
      );

      expect(result).toEqual({
        version: 4,
        published_at: '2026-10-22T08:00:00.000Z',
        items: [
          { position: 1, ...kind },
          { position: 2, ...spam },
        ],
      });
      expect(writes()).toHaveLength(0);
      expect(events).toEqual(['begin', 'commit', 'release']);
    });

    it('treats a reorder of the same items as a new version', async () => {
      results = [
        [community],
        [currentDocument([kind, spam], 4)],
        { affectedRows: 1 },
        { affectedRows: 2 },
        [{ published_at: publishedAt }],
      ];

      const result = await service.publish(
        'gardening',
        { items: [spam, kind] },
        'creator',
      );

      expect(result.version).toBe(5);
      expect(writes()).toHaveLength(2);
    });

    it('reports an unknown community as 404 before checking authorization', async () => {
      results = [[]];

      await expect(
        service.publish('missing', { items: [kind] }, 'anyone'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(writes()).toHaveLength(0);
      expect(events).toEqual(['begin', 'rollback', 'release']);
    });

    it('rejects a non-creator, including a moderator, with 403', async () => {
      results = [[community]];

      await expect(
        service.publish('gardening', { items: [kind] }, 'moderator'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(queries).toHaveLength(1);
      expect(writes()).toHaveLength(0);
      expect(events).toEqual(['begin', 'rollback', 'release']);
    });

    it('maps a competing insert of the same version to 409 and rolls back', async () => {
      // Another publish commits version 2 between this request's hash check
      // and its insert, so the unique (community_id, version) key fires.
      results = [
        [community],
        [currentDocument([kind], 1)],
        () =>
          Object.assign(new Error('Duplicate entry'), {
            code: 'ER_DUP_ENTRY',
          }),
      ];

      await expect(
        service.publish('gardening', { items: [spam] }, 'creator'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(events).toEqual(['begin', 'rollback', 'release']);
      expect(
        queries.some((query) => query.sql.includes('INTO community_rules ')),
      ).toBe(false);
    });

    it('rolls back the document when inserting the items fails', async () => {
      const failure = new Error('Connection lost');
      results = [[community], [], { affectedRows: 1 }, () => failure];

      await expect(
        service.publish('gardening', { items: [kind] }, 'creator'),
      ).rejects.toBe(failure);
      expect(events).toEqual(['begin', 'rollback', 'release']);
    });

    it('releases the connection when the transaction cannot start', async () => {
      const failure = new Error('Cannot begin');
      const connection = {
        execute,
        beginTransaction: () => Promise.reject(failure),
        rollback: () => {
          events.push('rollback');
          return Promise.resolve();
        },
        release: () => {
          events.push('release');
        },
      };
      const module = await Test.createTestingModule({
        providers: [
          CommunityRulesService,
          CommunityRuleAcceptanceService,
          {
            provide: MYSQL_POOL,
            useValue: { getConnection: () => Promise.resolve(connection) },
          },
        ],
      }).compile();

      await expect(
        module
          .get(CommunityRulesService)
          .publish('gardening', { items: [kind] }, 'creator'),
      ).rejects.toBe(failure);
      expect(events).toEqual(['release']);
    });
  });

  describe('canPublishCommunityRules', () => {
    it('allows only the community creator', () => {
      expect(canPublishCommunityRules(community, 'creator')).toBe(true);
      expect(canPublishCommunityRules(community, 'moderator')).toBe(false);
    });
  });

  describe('reads', () => {
    it('returns the current version items in position order', async () => {
      results = [
        [community],
        [currentDocument([kind], 2)],
        [{ position: 1, ...kind }],
      ];

      await expect(service.getCurrent('gardening')).resolves.toEqual({
        version: 2,
        published_at: '2026-10-22T08:00:00.000Z',
        items: [{ position: 1, ...kind }],
      });
      expect(queries[2].sql).toContain('ORDER BY position ASC');
      expect(queries[2].values).toEqual(['document-2']);
    });

    it('returns an empty document for a community without rules', async () => {
      results = [[community], []];

      await expect(service.getCurrent('gardening')).resolves.toEqual({
        version: null,
        published_at: null,
        items: [],
      });
    });

    it('returns 404 for an unknown community or version', async () => {
      results = [[]];
      await expect(service.getCurrent('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      results = [[community], []];
      await expect(service.getVersion('gardening', 9)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(queries[2].values).toEqual(['community-1', 9]);
    });

    it('maps history newest first and renders a deleted publisher as null', async () => {
      results = [
        [community],
        [
          {
            version: 2,
            published_at: publishedAt,
            published_by_username: 'creator_name',
            rule_count: 3,
          },
          {
            version: 1,
            published_at: new Date('2026-10-20T08:00:00.000Z'),
            published_by_username: null,
            rule_count: '1',
          },
        ],
        [{ total: 12 }],
      ];

      const result = await service.listVersions('gardening', {
        page: 2,
        limit: 2,
      });

      expect(result).toEqual({
        items: [
          {
            version: 2,
            published_at: '2026-10-22T08:00:00.000Z',
            published_by_username: 'creator_name',
            rule_count: 3,
          },
          {
            version: 1,
            published_at: '2026-10-20T08:00:00.000Z',
            published_by_username: null,
            rule_count: 1,
          },
        ],
        page: 2,
        limit: 2,
        total: 12,
      });
      expect(queries[1].sql).toContain('LEFT JOIN users u');
      expect(queries[1].sql).toContain('ORDER BY d.version DESC');
      expect(queries[1].values).toEqual(['community-1', 2, 2]);
    });
  });

  describe('acceptance', () => {
    const acceptedAt = new Date('2026-10-20T12:00:00.000Z');
    const state = (version: number, accepted: Date | null) => [
      { document_id: `document-${version}`, version, accepted_at: accepted },
    ];
    const latest = (version: number) => [{ version, accepted_at: acceptedAt }];
    const inserts = () =>
      queries.filter((query) =>
        query.sql.includes('INSERT INTO community_rule_acceptances'),
      );

    it.each([
      [
        'no published rules',
        [[], []],
        {
          current_version: null,
          accepted_version: null,
          accepted_at: null,
          acceptance_required: false,
        },
      ],
      [
        'an unaccepted current version after accepting an older one',
        [state(2, null), latest(1)],
        {
          current_version: 2,
          accepted_version: 1,
          accepted_at: '2026-10-20T12:00:00.000Z',
          acceptance_required: true,
        },
      ],
      [
        'nothing ever accepted',
        [state(1, null), []],
        {
          current_version: 1,
          accepted_version: null,
          accepted_at: null,
          acceptance_required: true,
        },
      ],
      [
        'the current version accepted',
        [state(2, acceptedAt), latest(2)],
        {
          current_version: 2,
          accepted_version: 2,
          accepted_at: '2026-10-20T12:00:00.000Z',
          acceptance_required: false,
        },
      ],
    ])('reports %s', async (_, rows, expected) => {
      results = [[community], ...rows];

      await expect(
        service.getAcceptance('gardening', 'user-a'),
      ).resolves.toEqual(expected);
      expect(queries[1].values).toEqual(['user-a', 'community-1']);
      expect(queries[2].values).toEqual(['user-a', 'community-1']);
    });

    it('returns 404 for an unknown community before reading any state', async () => {
      results = [[]];

      await expect(
        service.getAcceptance('missing', 'user-a'),
      ).rejects.toBeInstanceOf(NotFoundException);
      results = [[]];
      await expect(
        service.accept('missing', 'user-a', 1),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(inserts()).toHaveLength(0);
    });

    it('records a new acceptance for the bound user and reports it created', async () => {
      results = [
        [community],
        state(2, null),
        { affectedRows: 1 },
        state(2, acceptedAt),
        latest(2),
      ];

      const result = await service.accept('gardening', 'user-a', 2);

      expect(result).toEqual({
        created: true,
        acceptance: {
          current_version: 2,
          accepted_version: 2,
          accepted_at: '2026-10-20T12:00:00.000Z',
          acceptance_required: false,
        },
      });
      expect(inserts()).toHaveLength(1);
      expect(inserts()[0].values).toEqual(['user-a', 'community-1', 2]);
    });

    it('does not write or refresh accepted_at for a repeat acceptance', async () => {
      results = [
        [community],
        state(2, acceptedAt),
        state(2, acceptedAt),
        latest(2),
      ];

      const result = await service.accept('gardening', 'user-a', 2);

      expect(result.created).toBe(false);
      expect(result.acceptance.accepted_at).toBe('2026-10-20T12:00:00.000Z');
      expect(inserts()).toHaveLength(0);
    });

    it.each([
      ['stale', 1],
      ['ahead', 3],
    ])(
      'refuses a %s version with 409 after a non-matching insert',
      async (_, version) => {
        results = [
          [community],
          state(2, null),
          { affectedRows: 0 },
          state(2, null),
        ];

        await expect(
          service.accept('gardening', 'user-a', version),
        ).rejects.toThrow(
          new ConflictException(
            `Version ${version} is not the current rules version (2)`,
          ),
        );
      },
    );

    it('refuses with a distinct 409 when the community has no rules', async () => {
      results = [[community], [], { affectedRows: 0 }, []];

      await expect(service.accept('gardening', 'user-a', 1)).rejects.toThrow(
        new ConflictException(
          'This community has no published rules to accept',
        ),
      );
    });

    it('still refuses when a new version lands between the check and the insert', async () => {
      // The check saw v2 as current, but the current-only insert matches
      // nothing because v3 was published in between.
      results = [
        [community],
        state(2, null),
        { affectedRows: 0 },
        state(3, null),
      ];

      await expect(service.accept('gardening', 'user-a', 2)).rejects.toThrow(
        'Version 2 is not the current rules version (3)',
      );
    });
  });
});
