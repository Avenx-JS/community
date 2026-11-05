import {
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommentsService } from './comments.service';

// Every community's rules count as accepted unless a test says otherwise.
const acceptingRuleAcceptance = {
  provide: CommunityRuleAcceptanceService,
  useValue: { assertAcceptedOrThrow: () => Promise.resolve() },
};

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
        acceptingRuleAcceptance,
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
        acceptingRuleAcceptance,
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
        acceptingRuleAcceptance,
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

describe('CommentsService.remove', () => {
  let service: CommentsService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let comment: Record<string, unknown> | undefined;
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
    comment = {
      id: 'comment-1',
      author_id: 'author',
      content: 'Mine ripened early.',
      community_id: 'community-1',
      can_moderate: 0,
    };
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT comments.id')) {
          return Promise.resolve([comment ? [comment] : [], []]);
        }
        if (sql.startsWith('DELETE FROM comments')) {
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      },
    };
    notifications = { record: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        acceptingRuleAcceptance,
        CommentsService,
        {
          provide: MYSQL_POOL,
          useValue: { getConnection: () => Promise.resolve(connection) },
        },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(CommentsService);
  });

  const deletes = () =>
    queries.filter((query) => query.sql.startsWith('DELETE FROM comments'));

  function expectRolledBackAndReleased() {
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  }

  it('locks only the comment row and decides authorisation in the service', async () => {
    await service.remove('comment-1', 'author');

    expect(queries[0].sql).toContain('INNER JOIN posts');
    expect(queries[0].sql).toContain('community_moderators');
    expect(queries[0].sql).toMatch(/FOR UPDATE OF comments$/);
    expect(queries[0].values).toEqual(['author', 'author', 'comment-1']);
    expect(deletes()).toEqual([
      { sql: 'DELETE FROM comments WHERE id = ?', values: ['comment-1'] },
    ]);
  });

  it('lets the author delete without a notification, even as a moderator', async () => {
    await service.remove('comment-1', 'author');
    comment = { ...comment, can_moderate: 1 };
    await service.remove('comment-1', 'author');

    expect(deletes()).toHaveLength(2);
    expect(notifications.record).not.toHaveBeenCalled();
  });

  it('lets a moderator or creator delete and notifies the author', async () => {
    comment = { ...comment, can_moderate: 1 };

    await expect(
      service.remove('comment-1', 'moderator'),
    ).resolves.toBeUndefined();

    expect(notifications.record).toHaveBeenCalledTimes(1);
    expect(notifications.record).toHaveBeenCalledWith(connection, {
      recipientId: 'author',
      type: 'content_removed',
      actorId: null,
      subjectType: 'comment',
      subjectId: 'comment-1',
      communityId: 'community-1',
      metadata: { excerpt: 'Mine ripened early.' },
    });
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('returns 403 to anyone else and 404 for a missing comment, deleting nothing', async () => {
    await expect(service.remove('comment-1', 'stranger')).rejects.toThrow(
      new ForbiddenException(
        'You can only delete your own comments or moderate this community',
      ),
    );
    expectRolledBackAndReleased();

    connection.rollback.mockClear();
    connection.release.mockClear();
    comment = undefined;
    await expect(service.remove('missing', 'stranger')).rejects.toThrow(
      new NotFoundException('Comment not found'),
    );
    expectRolledBackAndReleased();

    expect(deletes()).toEqual([]);
    expect(notifications.record).not.toHaveBeenCalled();
  });

  it('rolls the deletion back when the notification write fails', async () => {
    comment = { ...comment, can_moderate: 1 };
    notifications.record.mockRejectedValueOnce(new Error('insert failed'));

    await expect(service.remove('comment-1', 'moderator')).rejects.toThrow(
      'insert failed',
    );

    expectRolledBackAndReleased();
  });
});

describe('CommentsService paginated listings', () => {
  let service: CommentsService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let results: unknown[];

  const row = (id: string, parentId: string | null = 'parent-1') => ({
    id,
    post_id: 'post-1',
    parent_id: parentId,
    author_id: 'user-1',
    content: `Content of ${id}`,
    created_at: new Date('2026-10-22T08:00:00.000Z'),
    edited_at: null,
  });
  const listing = () => queries.find(({ sql }) => sql.includes('ORDER BY'));
  const counting = () =>
    queries.find(({ sql }) => sql.startsWith('SELECT COUNT(*) AS total'));
  const grouping = () =>
    queries.filter(({ sql }) => sql.includes('GROUP BY parent_id'));

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
      providers: [
        acceptingRuleAcceptance,
        CommentsService,
        { provide: MYSQL_POOL, useValue: pool },
        { provide: NotificationsService, useValue: {} },
      ],
    }).compile();
    service = module.get(CommentsService);
  });

  describe('findReplies', () => {
    it('binds the parent id, checks the community, and 404s an unknown comment', async () => {
      results = [[]];
      await expect(service.findReplies('missing', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(queries).toHaveLength(1);
      expect(queries[0].values).toEqual(['missing']);
      expect(queries[0].sql).toContain('comments.id = ?');
      expect(queries[0].sql).toContain('communities.deleted_at IS NULL');
      // The parent lookup ignores removal, so the replies of a removed
      // comment stay readable.
      expect(queries[0].sql).not.toContain('removed_at');
    });

    it('selects only visible direct children, oldest first by default', async () => {
      results = [
        [{ id: 'parent-1' }],
        [row('a'), row('b')],
        [{ total: 2 }],
        [],
      ];

      const result = await service.findReplies('parent-1', {});

      expect(result).toMatchObject({
        page: 1,
        limit: 20,
        total: 2,
        sort: 'oldest',
      });
      const { sql, values } = listing()!;
      expect(sql).toContain('WHERE parent_id = ? AND removed_at IS NULL');
      expect(sql).not.toContain('post_id = ?');
      expect(sql).toContain('ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?');
      expect(values).toEqual(['parent-1', 20, 0]);
      expect(counting()).toEqual({
        sql: 'SELECT COUNT(*) AS total FROM comments WHERE parent_id = ? AND removed_at IS NULL',
        values: ['parent-1'],
      });
    });

    it('orders newest first, id descending, for sort=new', async () => {
      results = [[{ id: 'parent-1' }], [], [{ total: 0 }]];
      const result = await service.findReplies('parent-1', { sort: 'new' });
      expect(listing()!.sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(result.sort).toBe('new');
    });

    it.each([
      { page: 1, limit: 20, offset: 0 },
      { page: 3, limit: 7, offset: 14 },
      { page: 10000, limit: 100, offset: 999900 },
    ])('pages with LIMIT/OFFSET for %o', async ({ page, limit, offset }) => {
      results = [[{ id: 'parent-1' }], [], [{ total: 0 }]];
      const result = await service.findReplies('parent-1', { page, limit });
      expect(listing()!.values).toEqual(['parent-1', limit, offset]);
      expect(result).toMatchObject({ page, limit });
    });

    it('returns flat items with reply_count from one grouped query', async () => {
      results = [
        [{ id: 'parent-1' }],
        [row('with-children'), row('leaf')],
        [{ total: 2 }],
        [{ parent_id: 'with-children', reply_count: '3' }],
      ];

      const result = await service.findReplies('parent-1', {});

      expect(result.items).toEqual([
        {
          id: 'with-children',
          post_id: 'post-1',
          parent_id: 'parent-1',
          author_id: 'user-1',
          content: 'Content of with-children',
          created_at: '2026-10-22T08:00:00.000Z',
          edited_at: null,
          reply_count: 3,
        },
        expect.objectContaining({ id: 'leaf', reply_count: 0 }),
      ]);
      for (const item of result.items) {
        expect(item).not.toHaveProperty('replies');
      }
      expect(grouping()).toEqual([
        {
          sql: 'SELECT parent_id, COUNT(*) AS reply_count FROM comments WHERE parent_id IN (?, ?) AND removed_at IS NULL GROUP BY parent_id',
          values: ['with-children', 'leaf'],
        },
      ]);
    });

    it('issues the same number of queries whatever the page size', async () => {
      const counts: number[] = [];
      for (const size of [1, 20, 100]) {
        queries = [];
        const page = Array.from({ length: size }, (_, index) =>
          row(`r-${index}`),
        );
        results = [[{ id: 'parent-1' }], page, [{ total: size }], []];
        await service.findReplies('parent-1', { limit: size });
        counts.push(queries.length);
        expect(grouping()).toHaveLength(1);
        expect(grouping()[0].values).toHaveLength(size);
      }
      expect(counts).toEqual([4, 4, 4]);
    });

    it('answers a comment without replies with an empty page, skipping the grouped count', async () => {
      results = [[{ id: 'parent-1' }], [], [{ total: 0 }]];
      await expect(service.findReplies('parent-1', {})).resolves.toEqual({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
        sort: 'oldest',
      });
      expect(grouping()).toHaveLength(0);
    });

    it('renders edited_at when set', async () => {
      results = [
        [{ id: 'parent-1' }],
        [{ ...row('a'), edited_at: new Date('2026-10-23T08:00:00.000Z') }],
        [{ total: 1 }],
        [],
      ];
      const result = await service.findReplies('parent-1', {});
      expect(result.items[0].edited_at).toBe('2026-10-23T08:00:00.000Z');
    });
  });

  describe('findTopLevel', () => {
    it('404s an unknown post or one in a deleted community, listing nothing', async () => {
      results = [[]];
      await expect(service.findTopLevel('missing', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain('communities.deleted_at IS NULL');
    });

    it('selects visible roots of the post with the parent_id IS NULL predicate', async () => {
      results = [[{ id: 'post-1' }], [row('root', null)], [{ total: 1 }], []];

      const result = await service.findTopLevel('post-1', {
        page: 2,
        limit: 5,
        sort: 'new',
      });

      const { sql, values } = listing()!;
      expect(sql).toContain(
        'WHERE post_id = ? AND parent_id IS NULL AND removed_at IS NULL',
      );
      expect(sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(values).toEqual(['post-1', 5, 5]);
      expect(counting()!.sql).toContain(
        'WHERE post_id = ? AND parent_id IS NULL AND removed_at IS NULL',
      );
      expect(result).toMatchObject({
        items: [{ id: 'root', parent_id: null, reply_count: 0 }],
        page: 2,
        limit: 5,
        total: 1,
        sort: 'new',
      });
    });
  });

  it('names the paginated routes in the 413 of the tree route', async () => {
    results = [
      [{ id: 'post-1' }],
      Array.from({ length: 501 }, (_, index) => row(`c-${index}`, null)),
    ];
    await expect(service.findThread('post-1')).rejects.toMatchObject({
      status: 413,
      message: expect.stringContaining(
        'GET /posts/:postId/comments/top-level and GET /comments/:id/replies',
      ) as unknown,
    });
  });
});
