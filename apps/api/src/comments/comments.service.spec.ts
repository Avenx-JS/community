import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommentsService } from './comments.service';

describe('CommentsService', () => {
  let service: CommentsService;
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
      providers: [CommentsService, { provide: MYSQL_POOL, useValue: pool }],
    }).compile();

    service = module.get<CommentsService>(CommentsService);
  });

  it('builds a stable nested thread from parent IDs', async () => {
    results = [
      [{ id: 'post-1' }],
      [
        {
          id: 'root-a',
          post_id: 'post-1',
          author_id: 'user-1',
          parent_id: null,
          content: 'Root',
          created_at: new Date('2026-10-22T08:00:00.000Z'),
        },
        {
          id: 'reply-a',
          post_id: 'post-1',
          author_id: 'user-2',
          parent_id: 'root-a',
          content: 'Reply',
          created_at: new Date('2026-10-22T08:01:00.000Z'),
        },
        {
          id: 'reply-to-reply',
          post_id: 'post-1',
          author_id: 'user-1',
          parent_id: 'reply-a',
          content: 'Nested reply',
          created_at: new Date('2026-10-22T08:02:00.000Z'),
        },
        {
          id: 'root-b',
          post_id: 'post-1',
          author_id: 'user-3',
          parent_id: null,
          content: 'Second root',
          created_at: new Date('2026-10-22T08:03:00.000Z'),
        },
      ],
    ];

    const result = await service.findThread('post-1');

    expect(result.comments.map((comment) => comment.id)).toEqual([
      'root-a',
      'root-b',
    ]);
    expect(result.comments[0].replies[0].replies[0]).toMatchObject({
      id: 'reply-to-reply',
      parent_id: 'reply-a',
    });
    expect(queries[1].sql).toContain('ORDER BY created_at ASC, id ASC');
  });

  it('rejects missing posts and parent comments not belonging to the post', async () => {
    results = [[]];
    await expect(service.findThread('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    results = [[{ id: 'post-1' }], []];
    await expect(
      service.create(
        'post-1',
        { content: 'Reply', parent_id: 'foreign-parent' },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(queries[2].values).toEqual(['foreign-parent', 'post-1']);
  });

  it('creates comments with the authenticated author', async () => {
    results = [
      [{ id: 'post-1' }],
      [],
      [
        {
          id: 'comment-created',
          post_id: 'post-1',
          author_id: 'authenticated-user',
          parent_id: null,
          content: 'A comment',
          created_at: new Date('2026-10-22T08:00:00.000Z'),
        },
      ],
    ];

    const result = await service.create(
      'post-1',
      { content: ' A comment ' },
      'authenticated-user',
    );
    expect(result).toMatchObject({
      id: 'comment-created',
      author_id: 'authenticated-user',
      parent_id: null,
      content: 'A comment',
      replies: [],
    });
    expect(queries[1].values).toEqual([
      expect.any(String),
      'post-1',
      'authenticated-user',
      null,
      'A comment',
    ]);
  });

  it('only deletes comments belonging to the authenticated author', async () => {
    results = [[{ author_id: 'other-user' }]];
    await expect(service.remove('comment-1', 'user-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(queries).toHaveLength(1);

    results = [[{ author_id: 'user-1' }], [{ affectedRows: 1 }]];
    await expect(
      service.remove('comment-1', 'user-1'),
    ).resolves.toBeUndefined();
    expect(queries[2]).toEqual({
      sql: 'DELETE FROM comments WHERE id = ? AND author_id = ?',
      values: ['comment-1', 'user-1'],
    });

    results = [[]];
    await expect(service.remove('missing', 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
