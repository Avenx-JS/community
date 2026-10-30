import {
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommentsService } from './comments.service';

describe('CommentsService', () => {
  let service: CommentsService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let results: unknown[];
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  let notifications: { record: jest.Mock };

  beforeEach(async () => {
    queries = [];
    results = [];
    // The pool and the transaction connection share one query log and one
    // result queue, so a test reads the same whichever of them a query uses.
    const execute = (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return Promise.resolve([results.shift() ?? [], []] as [unknown, unknown]);
    };
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute,
    };
    notifications = { record: jest.fn().mockResolvedValue(undefined) };
    const pool = {
      execute,
      getConnection: () => Promise.resolve(connection),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: MYSQL_POOL, useValue: pool },
        { provide: NotificationsService, useValue: notifications },
      ],
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
    expect(queries[1].values).toEqual(['post-1', 501]);
  });

  it('rejects a thread that exceeds the bounded result size', async () => {
    results = [
      [{ id: 'post-1' }],
      Array.from({ length: 501 }, (_, index) => ({
        id: `comment-${index}`,
        post_id: 'post-1',
        author_id: 'user-1',
        parent_id: null,
        content: 'comment',
        created_at: new Date('2026-10-22T08:00:00.000Z'),
      })),
    ];

    await expect(service.findThread('post-1')).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
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
    results = [{ affectedRows: 0 }, [{ id: 'comment-1' }]];
    await expect(service.remove('comment-1', 'user-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    results = [{ affectedRows: 1 }];
    await expect(
      service.remove('comment-1', 'user-1'),
    ).resolves.toBeUndefined();

    results = [{ affectedRows: 0 }, []];
    await expect(service.remove('missing', 'user-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('allows moderators to delete comments in their community', async () => {
    results = [{ affectedRows: 1 }];

    await expect(
      service.remove('comment-1', 'community-moderator'),
    ).resolves.toBeUndefined();
    expect(queries[0].sql).toContain('community_moderators');
    expect(queries[0].values).toEqual([
      'comment-1',
      'community-moderator',
      'community-moderator',
      'community-moderator',
    ]);
  });
});

describe('CommentsService.create notifications', () => {
  const post = {
    id: 'post-1',
    author_id: 'post-author',
    community_id: 'community-1',
    title: 'First tomatoes',
  };
  const createdComment = (overrides: Record<string, unknown> = {}) => ({
    id: 'comment-new',
    post_id: 'post-1',
    author_id: 'commenter',
    parent_id: null,
    content: 'Mine ripened early.',
    created_at: new Date('2026-10-30T08:00:00.000Z'),
    ...overrides,
  });

  let service: CommentsService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let results: unknown[];
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  let notifications: { record: jest.Mock };

  beforeEach(async () => {
    queries = [];
    results = [];
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values });
        return Promise.resolve([results.shift() ?? [], []]);
      },
    };
    notifications = { record: jest.fn().mockResolvedValue(undefined) };
    const pool = {
      execute: () =>
        Promise.reject(new Error('create must use its own connection')),
      getConnection: () => Promise.resolve(connection),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: MYSQL_POOL, useValue: pool },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get<CommentsService>(CommentsService);
  });

  function expectCommittedAndReleased() {
    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  }

  function expectRolledBackAndReleased() {
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  }

  it('notifies the post author once about a top-level comment, inside the transaction', async () => {
    results = [[post], { affectedRows: 1 }, [createdComment()]];

    const result = await service.create(
      'post-1',
      { content: ' Mine ripened early. ' },
      'commenter',
    );

    expect(result).toEqual({
      id: 'comment-new',
      post_id: 'post-1',
      author_id: 'commenter',
      parent_id: null,
      content: 'Mine ripened early.',
      created_at: '2026-10-30T08:00:00.000Z',
      replies: [],
    });
    expect(notifications.record).toHaveBeenCalledTimes(1);
    expect(notifications.record).toHaveBeenCalledWith(connection, {
      recipientId: 'post-author',
      type: 'post_comment',
      actorId: 'commenter',
      subjectType: 'comment',
      subjectId: 'comment-new',
      communityId: 'community-1',
      metadata: {
        post_id: 'post-1',
        post_title: 'First tomatoes',
        excerpt: 'Mine ripened early.',
      },
    });
    expect(notifications.record.mock.invocationCallOrder[0]).toBeLessThan(
      connection.commit.mock.invocationCallOrder[0],
    );
    expectCommittedAndReleased();
  });

  it('notifies only the parent comment author about a reply', async () => {
    results = [
      [post],
      [{ id: 'parent-1', author_id: 'parent-author' }],
      { affectedRows: 1 },
      [createdComment({ parent_id: 'parent-1', content: 'Same here.' })],
    ];

    await service.create(
      'post-1',
      { content: 'Same here.', parent_id: 'parent-1' },
      'commenter',
    );

    expect(queries[1]).toEqual({
      sql: 'SELECT id, author_id FROM comments WHERE id = ? AND post_id = ? LIMIT 1',
      values: ['parent-1', 'post-1'],
    });
    expect(notifications.record).toHaveBeenCalledTimes(1);
    expect(notifications.record).toHaveBeenCalledWith(connection, {
      recipientId: 'parent-author',
      type: 'comment_reply',
      actorId: 'commenter',
      subjectType: 'comment',
      subjectId: 'comment-new',
      communityId: 'community-1',
      metadata: {
        post_id: 'post-1',
        parent_comment_id: 'parent-1',
        excerpt: 'Same here.',
      },
    });
    expect(notifications.record).not.toHaveBeenCalledWith(
      connection,
      expect.objectContaining({ recipientId: 'post-author' }),
    );
    expectCommittedAndReleased();
  });

  it('writes one comment_reply and no post_comment for a reply to the post author', async () => {
    results = [
      [post],
      [{ id: 'parent-1', author_id: 'post-author' }],
      { affectedRows: 1 },
      [createdComment({ parent_id: 'parent-1' })],
    ];

    await service.create(
      'post-1',
      { content: 'Mine ripened early.', parent_id: 'parent-1' },
      'commenter',
    );

    expect(notifications.record).toHaveBeenCalledTimes(1);
    expect(notifications.record).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({
        recipientId: 'post-author',
        type: 'comment_reply',
      }),
    );
  });

  it('leaves self-notification suppression to NotificationsService', async () => {
    results = [
      [post],
      { affectedRows: 1 },
      [createdComment({ author_id: 'post-author' })],
    ];

    await service.create(
      'post-1',
      { content: 'Mine ripened early.' },
      'post-author',
    );

    expect(notifications.record).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({
        recipientId: 'post-author',
        actorId: 'post-author',
      }),
    );
  });

  it('rolls the comment back and releases when the notification write fails', async () => {
    results = [[post], { affectedRows: 1 }, [createdComment()]];
    notifications.record.mockRejectedValueOnce(new Error('insert failed'));

    await expect(
      service.create('post-1', { content: 'Mine ripened early.' }, 'commenter'),
    ).rejects.toThrow('insert failed');

    expect(queries.map((query) => query.sql)).toContain(
      'INSERT INTO comments (id, post_id, author_id, parent_id, content) VALUES (?, ?, ?, ?, ?)',
    );
    expectRolledBackAndReleased();
  });

  it('keeps its 404s and releases the connection on them', async () => {
    results = [[]];
    await expect(
      service.create('missing', { content: 'Comment' }, 'commenter'),
    ).rejects.toThrow(new NotFoundException('Post not found'));
    expectRolledBackAndReleased();

    connection.rollback.mockClear();
    connection.release.mockClear();
    results = [[post], []];
    await expect(
      service.create(
        'post-1',
        { content: 'Comment', parent_id: 'foreign-parent' },
        'commenter',
      ),
    ).rejects.toThrow(
      new NotFoundException('Parent comment not found for this post'),
    );
    expectRolledBackAndReleased();
    expect(notifications.record).not.toHaveBeenCalled();
  });

  it('releases the connection when the transaction cannot start', async () => {
    connection.beginTransaction.mockRejectedValueOnce(new Error('no tx'));

    await expect(
      service.create('post-1', { content: 'Comment' }, 'commenter'),
    ).rejects.toThrow('no tx');

    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  });
});

// The same producer against the real NotificationsService, over a fake that
// enforces the notifications unique key.
describe('CommentsService.create with NotificationsService', () => {
  interface StoredComment {
    id: string;
    post_id: string;
    author_id: string;
    parent_id: string | null;
    content: string;
    created_at: Date;
  }

  let service: CommentsService;
  let notificationsService: NotificationsService;
  let comments: StoredComment[];
  let rows: Array<{ recipient_id: string; type: string; subject: string }>;
  let connection: {
    beginTransaction: () => Promise<void>;
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
    release: () => void;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };

  beforeEach(async () => {
    comments = [
      {
        id: 'root-1',
        post_id: 'post-1',
        author_id: 'post-author',
        parent_id: null,
        content: 'Root',
        created_at: new Date('2026-10-30T08:00:00.000Z'),
      },
    ];
    rows = [];
    connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
      execute: (sql, values) => {
        if (sql.startsWith('SELECT id, author_id, community_id, title')) {
          return Promise.resolve([
            values[0] === 'post-1'
              ? [
                  {
                    id: 'post-1',
                    author_id: 'post-author',
                    community_id: 'community-1',
                    title: 'First tomatoes',
                  },
                ]
              : [],
            [],
          ]);
        }
        if (sql.startsWith('SELECT id, author_id FROM comments')) {
          return Promise.resolve([
            comments.filter(
              (comment) =>
                comment.id === values[0] && comment.post_id === values[1],
            ),
            [],
          ]);
        }
        if (sql.startsWith('INSERT INTO comments')) {
          const [id, postId, authorId, parentId, content] = values as [
            string,
            string,
            string,
            string | null,
            string,
          ];
          comments.push({
            id,
            post_id: postId,
            author_id: authorId,
            parent_id: parentId,
            content,
            created_at: new Date('2026-10-30T09:00:00.000Z'),
          });
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('SELECT id, post_id, author_id, parent_id')) {
          return Promise.resolve([
            comments.filter((comment) => comment.id === values[0]),
            [],
          ]);
        }
        if (sql.startsWith('INSERT INTO notifications')) {
          for (let index = 0; index < values.length; index += 8) {
            const [, recipientId, type, , subjectType, subjectId] =
              values.slice(index, index + 8) as string[];
            const subject = `${subjectType}:${subjectId}`;
            if (
              !rows.some(
                (row) =>
                  row.recipient_id === recipientId &&
                  row.type === type &&
                  row.subject === subject,
              )
            ) {
              rows.push({ recipient_id: recipientId, type, subject });
            }
          }
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      },
    };
    const pool = { getConnection: () => Promise.resolve(connection) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        NotificationsService,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();

    service = module.get(CommentsService);
    notificationsService = module.get(NotificationsService);
  });

  it('writes nothing for a comment on your own post or a reply to your own comment', async () => {
    await service.create('post-1', { content: 'Own post' }, 'post-author');
    await service.create(
      'post-1',
      { content: 'Own comment', parent_id: 'root-1' },
      'post-author',
    );

    expect(rows).toEqual([]);
  });

  it('writes one row per comment, and one for a retried write of the same comment', async () => {
    const first = await service.create(
      'post-1',
      { content: 'First' },
      'commenter',
    );
    const second = await service.create(
      'post-1',
      { content: 'Second' },
      'commenter',
    );
    await notificationsService.record(connection as never, {
      recipientId: 'post-author',
      type: 'post_comment',
      actorId: 'commenter',
      subjectType: 'comment',
      subjectId: first.id,
      communityId: 'community-1',
      metadata: {
        post_id: 'post-1',
        post_title: 'First tomatoes',
        excerpt: 'First',
      },
    });

    expect(rows).toEqual([
      {
        recipient_id: 'post-author',
        type: 'post_comment',
        subject: `comment:${first.id}`,
      },
      {
        recipient_id: 'post-author',
        type: 'post_comment',
        subject: `comment:${second.id}`,
      },
    ]);
  });
});
