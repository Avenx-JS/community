import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunitiesService } from './communities.service';

describe('CommunitiesService', () => {
  let service: CommunitiesService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let results: unknown[][];

  beforeEach(async () => {
    queries = [];
    results = [];
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return Promise.resolve([results.shift() ?? [], []]);
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [CommunitiesService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();
    service = module.get<CommunitiesService>(CommunitiesService);
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
          rules: null,
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

  it('persists the authenticated creator and returns the created community', async () => {
    results = [
      [],
      [
        {
          id: 'community-created',
          creator_id: 'authenticated-user',
          name: 'gardening',
          description: null,
          rules: null,
          created_at: new Date('2026-10-20T12:00:00.000Z'),
        },
      ],
    ];

    const result = await service.create(
      { name: ' gardening ' },
      'authenticated-user',
    );

    expect(queries[0].sql).toContain(
      'INSERT INTO communities (id, creator_id, name, description, rules)',
    );
    expect(queries[0].values).toEqual([
      expect.any(String),
      'authenticated-user',
      'gardening',
      null,
      null,
    ]);
    expect(queries[1].values).toEqual([queries[0].values[0]]);
    expect(result).toMatchObject({
      id: 'community-created',
      creator_id: 'authenticated-user',
      name: 'gardening',
    });
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
});
