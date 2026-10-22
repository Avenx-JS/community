import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { PostsService } from './posts.service';

describe('PostsService', () => {
  let service: PostsService;
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
      providers: [PostsService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();

    service = module.get<PostsService>(PostsService);
  });

  it('lists posts filtered by community with stable pagination', async () => {
    results = [
      [
        {
          id: 'post-1',
          title: 'Hello',
          content: 'World',
          type: 'text',
          author_id: 'user-1',
          community_id: 'community-1',
          created_at: new Date('2026-10-22T08:00:00.000Z'),
        },
      ],
      [{ total: 2 }],
    ];

    const result = await service.findAll({
      community_id: 'community-1',
      page: 2,
      limit: 1,
      sort: 'new',
    });

    expect(result).toMatchObject({ page: 2, limit: 1, total: 2, sort: 'new' });
    expect(result.items[0].id).toBe('post-1');
    expect(queries[0].sql).toContain(
      'ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    );
    expect(queries[0].values).toEqual(['community-1', 1, 1]);
    expect(queries[1].values).toEqual(['community-1']);
  });

  it('creates a post with the supplied author and community', async () => {
    results = [
      [{ id: 'community-1' }],
      [],
      [
        {
          id: 'post-1',
          title: 'Hello',
          content: 'World',
          type: 'text',
          author_id: 'user-1',
          community_id: 'community-1',
          created_at: new Date('2026-10-22T08:00:00.000Z'),
        },
      ],
    ];

    const result = await service.create(
      {
        title: ' Hello ',
        type: 'text',
        content: ' World ',
        community_id: 'community-1',
      },
      'user-1',
    );

    expect(result).toMatchObject({
      id: 'post-1',
      author_id: 'user-1',
      community_id: 'community-1',
      created_at: '2026-10-22T08:00:00.000Z',
    });
    expect(queries[1].values).toEqual([
      expect.any(String),
      'Hello',
      'World',
      'text',
      'user-1',
      'community-1',
    ]);
  });

  it('returns 404 for unknown communities and posts', async () => {
    results = [[]];
    await expect(
      service.create(
        {
          title: 'Hello',
          type: 'text',
          content: 'World',
          community_id: 'unknown',
        },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    results = [[]];
    await expect(service.findOne('unknown')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('deletes only the author’s post and returns not found for missing posts', async () => {
    results = [[{ author_id: 'other-user' }]];
    await expect(service.remove('post-1', 'user-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(queries).toHaveLength(1);

    results = [[{ author_id: 'user-1' }], [{ affectedRows: 1 }]];
    await expect(service.remove('post-1', 'user-1')).resolves.toBeUndefined();
    expect(queries[2]).toEqual({
      sql: 'DELETE FROM posts WHERE id = ? AND author_id = ?',
      values: ['post-1', 'user-1'],
    });

    results = [[]];
    await expect(service.remove('missing', 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
