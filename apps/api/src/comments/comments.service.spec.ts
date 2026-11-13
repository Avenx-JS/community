import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { REMOVED_CONTENT_REVIEWER_SQL } from '../common/removed-content';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CommentsService,
  INSERT_COMMENT_REVISION_SQL,
  MAX_LOCK_ANCESTOR_DEPTH,
  PARENT_WITH_ANCESTRY_SQL,
  THREAD_POST_SQL,
} from './comments.service';

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
      // The block lookup is answered outside the queue: no block here.
      if (sql.includes('FROM user_blocks')) {
        return Promise.resolve([[{ blocked: 0 }], []] as [unknown, unknown]);
      }
      // The ban lookup is answered outside the queue: no ban here.
      if (sql.includes('FROM community_bans')) {
        return Promise.resolve([[], []] as [unknown, unknown]);
      }
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
    expect(queries[2].values).toEqual([
      'foreign-parent',
      'post-1',
      MAX_LOCK_ANCESTOR_DEPTH,
      MAX_LOCK_ANCESTOR_DEPTH,
    ]);
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
        // The block lookup is answered outside the queue: no block here.
        if (sql.includes('FROM user_blocks')) {
          return Promise.resolve([[{ blocked: 0 }], []] as [unknown, unknown]);
        }
        // The ban lookup is answered outside the queue: no ban here.
        if (sql.includes('FROM community_bans')) {
          return Promise.resolve([[], []] as [unknown, unknown]);
        }
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
      edited_at: null,
      locked_at: null,
      locked_by: null,
      score: 0,
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
      sql: PARENT_WITH_ANCESTRY_SQL,
      values: [
        'parent-1',
        'post-1',
        MAX_LOCK_ANCESTOR_DEPTH,
        MAX_LOCK_ANCESTOR_DEPTH,
      ],
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
        if (sql.startsWith('WITH RECURSIVE ancestors')) {
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
        // The block lookup (UserBlockPolicyService): no block here.
        if (sql.includes('FROM user_blocks')) {
          return Promise.resolve([[{ blocked: 0 }], []]);
        }
        // The ban lookup (CommunityBanPolicyService): no ban here.
        if (sql.includes('FROM community_bans')) {
          return Promise.resolve([[], []]);
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
        // The block lookup (UserBlockPolicyService): no block here.
        if (sql.includes('FROM user_blocks')) {
          return Promise.resolve([[{ blocked: 0 }], []]);
        }
        // The ban lookup (CommunityBanPolicyService): no ban here.
        if (sql.includes('FROM community_bans')) {
          return Promise.resolve([[], []]);
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

  // The breaking change, pinned: a moderator or the creator may no longer
  // hard-delete someone else's comment; they are pointed at
  // POST /comments/:id/remove, and nothing is deleted or notified.
  it('refuses a moderator or creator with 403 naming the remove route', async () => {
    comment = { ...comment, can_moderate: 1 };

    await expect(service.remove('comment-1', 'moderator')).rejects.toThrow(
      new ForbiddenException(
        'Only the author may delete this comment; moderators remove comments with POST /comments/:id/remove',
      ),
    );

    expect(deletes()).toEqual([]);
    expect(notifications.record).not.toHaveBeenCalled();
    expectRolledBackAndReleased();
  });

  it('returns 403 to anyone else and 404 for a missing comment, deleting nothing', async () => {
    await expect(service.remove('comment-1', 'stranger')).rejects.toThrow(
      new ForbiddenException('You can only delete your own comments'),
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
    locked_at: null,
    locked_by: null,
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
        // The block lookup is answered outside the queue: no block here.
        if (sql.includes('FROM user_blocks')) {
          return Promise.resolve([[{ blocked: 0 }], []] as [unknown, unknown]);
        }
        // The ban lookup is answered outside the queue: no ban here.
        if (sql.includes('FROM community_bans')) {
          return Promise.resolve([[], []] as [unknown, unknown]);
        }
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
      // The parent, then the viewer (anonymous) of the readability check.
      expect(queries[0].values).toEqual(['missing', null]);
      expect(queries[0].sql).toContain('comments.id = ?');
      expect(queries[0].sql).toContain(
        'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
      );
      // The parent lookup ignores removal, so the replies of a removed
      // comment stay readable.
      expect(queries[0].sql).not.toContain('comments.removed_at');
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
          locked_at: null,
          locked_by: null,
          reply_count: 3,
          score: 0,
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
      // Page, total, grouped reply count, grouped score: whatever the size.
      expect(counts).toEqual([5, 5, 5]);
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
      expect(queries[0].sql).toContain(
        'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
      );
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

describe('CommentsService.update', () => {
  type StoredComment = {
    id: string;
    post_id: string;
    parent_id: string | null;
    author_id: string;
    content: string;
    created_at: Date;
    edited_at: Date | null;
    locked_at: Date | null;
    removed_at: Date | null;
    post_locked_at: Date | null;
    post_removed_at: Date | null;
  };
  let service: CommentsService;
  let comments: Map<string, StoredComment>;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let failUpdate: boolean;
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  const clock = new Date('2026-11-05T12:00:00.000Z');

  const addComment = (id: string, overrides: Partial<StoredComment> = {}) =>
    comments.set(id, {
      id,
      post_id: 'post-1',
      parent_id: 'root',
      author_id: 'author',
      content: 'Original',
      created_at: new Date('2026-10-22T08:00:00.000Z'),
      edited_at: null,
      locked_at: null,
      removed_at: null,
      post_locked_at: null,
      post_removed_at: null,
      ...overrides,
    });

  let revisions: unknown[][];

  // Migration 039: GET /comments/:id/revisions.
  it('keeps the replaced version, dated by when it was written', async () => {
    await service.update('comment-1', { content: 'Second' }, 'author');
    await service.update('comment-1', { content: 'Third' }, 'author');
    await service.update('comment-1', { content: 'Third' }, 'author');
    expect(revisions).toEqual([
      [
        expect.any(String),
        'comment-1',
        'Original',
        new Date('2026-10-22T08:00:00.000Z'),
      ],
      [expect.any(String), 'comment-1', 'Second', clock],
    ]);
  });

  beforeEach(async () => {
    comments = new Map();
    queries = [];
    revisions = [];
    failUpdate = false;
    addComment('comment-1');
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values });
        const comment = comments.get(values[0] as string);
        if (sql.startsWith('SELECT comments.id, comments.author_id')) {
          return Promise.resolve([comment ? [{ ...comment }] : [], []]);
        }
        // The replaced version (migration 039).
        if (sql === INSERT_COMMENT_REVISION_SQL) {
          revisions.push(values);
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('UPDATE comments SET')) {
          if (failUpdate) {
            return Promise.reject(new Error('write failed'));
          }
          const target = comments.get(values[1] as string)!;
          target.content = values[0] as string;
          target.edited_at = clock;
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('SELECT id, post_id, parent_id, author_id')) {
          return Promise.resolve([comment ? [{ ...comment }] : [], []]);
        }
        if (sql.startsWith('SELECT parent_id, COUNT(*) AS reply_count')) {
          return Promise.resolve([
            [{ parent_id: values[0], reply_count: 2 }],
            [],
          ]);
        }
        if (sql.startsWith('SELECT target_id, SUM(value) AS score')) {
          return Promise.resolve([[{ target_id: values[1], score: 3 }], []]);
        }
        // The block lookup (UserBlockPolicyService): no block here.
        if (sql.includes('FROM user_blocks')) {
          return Promise.resolve([[{ blocked: 0 }], []]);
        }
        // The ban lookup (CommunityBanPolicyService): no ban here.
        if (sql.includes('FROM community_bans')) {
          return Promise.resolve([[], []]);
        }
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        {
          provide: MYSQL_POOL,
          useValue: { getConnection: () => Promise.resolve(connection) },
        },
        { provide: NotificationsService, useValue: {} },
        // Editing is not participation: the rule gate must never be asked.
        {
          provide: CommunityRuleAcceptanceService,
          useValue: {
            assertAcceptedOrThrow: () =>
              Promise.reject(new Error('rule gate consulted')),
          },
        },
      ],
    }).compile();
    service = module.get(CommentsService);
  });

  const updates = () =>
    queries.filter(({ sql }) => sql.startsWith('UPDATE comments'));
  const expectRolledBackAndReleased = () => {
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(updates()).toHaveLength(0);
  };

  it('locks the comment row, joining its post, excluding hidden communities', async () => {
    await service.update('comment-1', { content: 'Fixed' }, 'author');
    const [read] = queries;
    expect(read.values).toEqual(['comment-1']);
    expect(read.sql).toContain('FOR UPDATE OF comments');
    expect(read.sql).toContain(
      'INNER JOIN posts ON posts.id = comments.post_id',
    );
    expect(read.sql).toContain(
      'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
    );
    expect(read.sql).toContain('communities.suspended_at IS NULL');
  });

  it('updates the content and stamps edited_at, returning the flat comment', async () => {
    const result = await service.update(
      'comment-1',
      { content: 'Fixed' },
      'author',
    );
    expect(updates()).toEqual([
      {
        sql: 'UPDATE comments SET content = ?, edited_at = UTC_TIMESTAMP() WHERE id = ?',
        values: ['Fixed', 'comment-1'],
      },
    ]);
    expect(result).toEqual({
      id: 'comment-1',
      post_id: 'post-1',
      parent_id: 'root',
      author_id: 'author',
      content: 'Fixed',
      created_at: '2026-10-22T08:00:00.000Z',
      edited_at: clock.toISOString(),
      locked_at: null,
      locked_by: null,
      reply_count: 2,
      score: 3,
    });
    expect(result).not.toHaveProperty('replies');
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('skips the write for identical content, leaving edited_at null', async () => {
    const result = await service.update(
      'comment-1',
      { content: 'Original' },
      'author',
    );
    expect(updates()).toHaveLength(0);
    expect(result.edited_at).toBeNull();
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it.each(['moderator', 'creator-1', 'stranger'])(
    'refuses %s with 403, writing nothing',
    async (actor) => {
      await expect(
        service.update('comment-1', { content: 'Hijack' }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expectRolledBackAndReleased();
    },
  );

  it('answers 404 for an unknown comment', async () => {
    await expect(
      service.update('missing', { content: 'x' }, 'author'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expectRolledBackAndReleased();
  });

  it.each([
    ['the comment is removed', { removed_at: clock }],
    ['its post is removed', { post_removed_at: clock }],
  ])('refuses with 409 when %s', async (_label, state) => {
    addComment('comment-1', state);
    await expect(
      service.update('comment-1', { content: 'x' }, 'author'),
    ).rejects.toBeInstanceOf(ConflictException);
    expectRolledBackAndReleased();
  });

  // A lock closes the discussion to new replies; it does not freeze what
  // was written, so the author may still correct a locked comment.
  it('lets the author edit a locked comment, or one on a locked post', async () => {
    addComment('comment-1', { locked_at: clock, post_locked_at: clock });
    await expect(
      service.update('comment-1', { content: 'Corrected' }, 'author'),
    ).resolves.toMatchObject({ content: 'Corrected' });
  });

  it('answers 403, not 409, to a non-author of a removed comment', async () => {
    addComment('comment-1', { removed_at: clock });
    await expect(
      service.update('comment-1', { content: 'x' }, 'stranger'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rolls back and releases when the write fails', async () => {
    failUpdate = true;
    await expect(
      service.update('comment-1', { content: 'Fixed' }, 'author'),
    ).rejects.toThrow('write failed');
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });
});

describe('CommentsService.create on locked threads', () => {
  let service: CommentsService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let postLocked: boolean;
  let ancestry: {
    id: string | null;
    author_id: string | null;
    thread_locked: number | string | null;
    depth_exceeded: number | string | null;
  };
  let assertAccepted: jest.Mock;
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };

  beforeEach(async () => {
    queries = [];
    postLocked = false;
    ancestry = {
      id: 'parent-1',
      author_id: 'parent-author',
      thread_locked: 0,
      depth_exceeded: 0,
    };
    assertAccepted = jest.fn().mockResolvedValue(undefined);
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT id, author_id, community_id, title')) {
          return Promise.resolve([
            values[0] === 'post-1'
              ? [
                  {
                    id: 'post-1',
                    author_id: 'post-author',
                    community_id: 'community-1',
                    title: 'Title',
                    locked_at: postLocked
                      ? new Date('2026-11-01T00:00:00.000Z')
                      : null,
                  },
                ]
              : [],
            [],
          ]);
        }
        if (sql.startsWith('WITH RECURSIVE ancestors')) {
          return Promise.resolve([[ancestry], []]);
        }
        if (sql.startsWith('INSERT INTO comments')) {
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('SELECT id, post_id, author_id, parent_id')) {
          return Promise.resolve([
            [
              {
                id: values[0],
                post_id: 'post-1',
                author_id: 'commenter',
                parent_id: null,
                content: 'Hi',
                created_at: new Date('2026-11-06T09:00:00.000Z'),
                edited_at: null,
                locked_at: null,
                locked_by: null,
              },
            ],
            [],
          ]);
        }
        // The block lookup (UserBlockPolicyService): no block here.
        if (sql.includes('FROM user_blocks')) {
          return Promise.resolve([[{ blocked: 0 }], []]);
        }
        // The ban lookup (CommunityBanPolicyService): no ban here.
        if (sql.includes('FROM community_bans')) {
          return Promise.resolve([[], []]);
        }
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        {
          provide: MYSQL_POOL,
          useValue: { getConnection: () => Promise.resolve(connection) },
        },
        {
          provide: NotificationsService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CommunityRuleAcceptanceService,
          useValue: { assertAcceptedOrThrow: assertAccepted },
        },
      ],
    }).compile();
    service = module.get(CommentsService);
  });

  const inserts = () =>
    queries.filter(({ sql }) => sql.startsWith('INSERT INTO comments'));
  const expectRefusedAndReleased = () => {
    expect(inserts()).toHaveLength(0);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  };

  it('reads the post with its lock state under a share lock', async () => {
    await service.create('post-1', { content: 'Hi' }, 'commenter');
    expect(queries[0].sql).toContain('locked_at');
    expect(queries[0].sql).toContain('FOR SHARE');
  });

  it('refuses a top-level comment on a locked post with 409, naming the post', async () => {
    postLocked = true;
    await expect(
      service.create('post-1', { content: 'Hi' }, 'commenter'),
    ).rejects.toMatchObject({
      status: 409,
      message: 'This post is locked; it accepts no new comments',
    });
    expectRefusedAndReleased();
  });

  it('refuses a reply when the parent or an ancestor is locked, naming the thread', async () => {
    ancestry.thread_locked = 1;
    await expect(
      service.create(
        'post-1',
        { content: 'Hi', parent_id: 'parent-1' },
        'commenter',
      ),
    ).rejects.toMatchObject({
      status: 409,
      message:
        'A comment above this reply is locked; its thread accepts no new replies',
    });
    expectRefusedAndReleased();
  });

  it('reads the ancestry with the bound, parent id and post id first', async () => {
    await service.create(
      'post-1',
      { content: 'Hi', parent_id: 'parent-1' },
      'commenter',
    );
    const read = queries.find(({ sql }) => sql.startsWith('WITH RECURSIVE'));
    expect(read).toEqual({
      sql: PARENT_WITH_ANCESTRY_SQL,
      values: [
        'parent-1',
        'post-1',
        MAX_LOCK_ANCESTOR_DEPTH,
        MAX_LOCK_ANCESTOR_DEPTH,
      ],
    });
    expect(MAX_LOCK_ANCESTOR_DEPTH).toBeLessThan(1000);
    expect(inserts()).toHaveLength(1);
  });

  it('fails closed when the walk reaches the bound with ancestors left', async () => {
    ancestry.depth_exceeded = '1';
    await expect(
      service.create(
        'post-1',
        { content: 'Hi', parent_id: 'parent-1' },
        'commenter',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expectRefusedAndReleased();
  });

  it('answers 404 before 409: an unknown post or parent on a locked path', async () => {
    postLocked = true;
    ancestry = {
      id: null,
      author_id: null,
      thread_locked: null,
      depth_exceeded: null,
    };
    await expect(
      service.create('missing', { content: 'Hi' }, 'commenter'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.create(
        'post-1',
        { content: 'Hi', parent_id: 'gone' },
        'commenter',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(assertAccepted).not.toHaveBeenCalled();
  });

  it('answers the rule gate before the lock', async () => {
    postLocked = true;
    assertAccepted.mockRejectedValueOnce(new ForbiddenException('rules'));
    await expect(
      service.create('post-1', { content: 'Hi' }, 'commenter'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CommentsService removed content', () => {
  let service: CommentsService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let postRemoved: boolean;
  let removedIds: Set<string>;
  const clock = new Date('2026-11-07T10:00:00.000Z');
  // root → reply (removed in the tests) → nested; and a sibling root.
  const rows = () =>
    [
      ['root', null, 'author-a'],
      ['reply', 'root', 'author-b'],
      ['nested', 'reply', 'author-a'],
      ['other-root', null, 'author-c'],
    ].map(([id, parent_id, author_id], index) => ({
      id,
      post_id: 'post-1',
      author_id,
      parent_id,
      content: `Content of ${id}`,
      created_at: new Date(Date.UTC(2026, 9, 22, 8, index)),
      edited_at: null,
      locked_at: null,
      locked_by: null,
      removed_at: removedIds.has(id as string) ? clock : null,
      removed_by: removedIds.has(id as string) ? null : null,
      removal_reason: removedIds.has(id as string) ? 'Rude' : null,
    }));
  const canReview = (viewer: unknown) =>
    ['moderator', 'creator-1', 'platform-admin'].includes(viewer as string);

  beforeEach(async () => {
    queries = [];
    postRemoved = false;
    removedIds = new Set();
    const execute = (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      if (sql === THREAD_POST_SQL) {
        return Promise.resolve([
          values[0] === 'post-1'
            ? [
                {
                  community_id: 'community-1',
                  removed_at: postRemoved ? clock : null,
                },
              ]
            : [],
          [],
        ]);
      }
      if (sql.startsWith('SELECT id, post_id, author_id, parent_id')) {
        return Promise.resolve([rows(), []]);
      }
      if (sql.startsWith('SELECT target_id, SUM(value) AS score')) {
        return Promise.resolve([[], []]);
      }
      if (sql === REMOVED_CONTENT_REVIEWER_SQL) {
        return Promise.resolve([
          [{ can_review: canReview(values[1]) ? 1 : 0 }],
          [],
        ]);
      }
      // The block lookup (UserBlockPolicyService): no block here.
      if (sql.includes('FROM user_blocks')) {
        return Promise.resolve([[{ blocked: 0 }], []]);
      }
      // The ban lookup (CommunityBanPolicyService): no ban here.
      if (sql.includes('FROM community_bans')) {
        return Promise.resolve([[], []]);
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: MYSQL_POOL, useValue: { execute } },
        { provide: NotificationsService, useValue: {} },
        acceptingRuleAcceptance,
      ],
    }).compile();
    service = module.get(CommentsService);
  });

  const reviewerChecks = () =>
    queries.filter(({ sql }) => sql === REMOVED_CONTENT_REVIEWER_SQL);

  it('asks nobody about reviewers when nothing in the thread is removed', async () => {
    const thread = await service.findThread('post-1', 'stranger');
    expect(thread.comments).toHaveLength(2);
    expect(reviewerChecks()).toHaveLength(0);
    expect(JSON.stringify(thread)).not.toMatch(/removed|removal_reason/);
  });

  it.each([undefined, 'author-b', 'stranger'])(
    'shows %s a removed comment as a tombstone, keeping its replies',
    async (viewer) => {
      removedIds.add('reply');
      const thread = await service.findThread('post-1', viewer);
      const tombstone = thread.comments[0].replies[0];
      expect(tombstone).toEqual({
        id: 'reply',
        post_id: 'post-1',
        parent_id: 'root',
        created_at: '2026-10-22T08:01:00.000Z',
        removed: true,
        replies: [
          expect.objectContaining({
            id: 'nested',
            content: 'Content of nested',
          }),
        ],
      });
      expect(tombstone).not.toHaveProperty('content');
      expect(tombstone).not.toHaveProperty('author_id');
      expect(JSON.stringify(thread)).not.toContain('Rude');
      expect(reviewerChecks()).toHaveLength(viewer ? 1 : 0);
    },
  );

  it.each(['moderator', 'creator-1', 'platform-admin'])(
    'shows %s the removed comment in full with its removal state',
    async (viewer) => {
      removedIds.add('reply');
      const thread = await service.findThread('post-1', viewer);
      expect(thread.comments[0].replies[0]).toMatchObject({
        id: 'reply',
        author_id: 'author-b',
        content: 'Content of reply',
        removed: true,
        removed_at: clock.toISOString(),
        removed_by: null,
        removal_reason: 'Rude',
        replies: [expect.objectContaining({ id: 'nested' })],
      });
      // Unremoved nodes carry no removal fields, even for reviewers.
      expect(thread.comments[0]).not.toHaveProperty('removed');
      expect(reviewerChecks()).toHaveLength(1);
    },
  );

  it('answers 404 for a removed post, except to its reviewers', async () => {
    postRemoved = true;
    for (const viewer of [undefined, 'author-a', 'stranger']) {
      await expect(service.findThread('post-1', viewer)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    await expect(
      service.findThread('post-1', 'moderator'),
    ).resolves.toMatchObject({ post_id: 'post-1' });
    // Only the post lookup ran for the refused viewers: no thread was read.
    expect(
      queries.filter(({ sql }) => sql.startsWith('SELECT id, post_id')),
    ).toHaveLength(1);
  });
});

describe('CommentsService.create on removed content', () => {
  let service: CommentsService;
  let postRemoved: boolean;
  let parentRemoved: number;
  let assertAccepted: jest.Mock;
  let inserts: number;

  beforeEach(async () => {
    postRemoved = false;
    parentRemoved = 0;
    inserts = 0;
    assertAccepted = jest.fn().mockResolvedValue(undefined);
    const execute = (sql: string) => {
      if (sql.startsWith('SELECT id, author_id, community_id, title')) {
        return Promise.resolve([
          [
            {
              id: 'post-1',
              author_id: 'post-author',
              community_id: 'community-1',
              title: 'Title',
              locked_at: new Date('2026-11-01T00:00:00.000Z'),
              removed_at: postRemoved ? new Date() : null,
            },
          ],
          [],
        ]);
      }
      if (sql.startsWith('WITH RECURSIVE ancestors')) {
        return Promise.resolve([
          [
            {
              id: 'parent-1',
              author_id: 'parent-author',
              parent_removed: parentRemoved,
              thread_locked: 1,
              depth_exceeded: 0,
            },
          ],
          [],
        ]);
      }
      // The block lookup (UserBlockPolicyService): no block here.
      if (sql.includes('FROM user_blocks')) {
        return Promise.resolve([[{ blocked: 0 }], []]);
      }
      // The ban lookup (CommunityBanPolicyService): no ban here.
      if (sql.includes('FROM community_bans')) {
        return Promise.resolve([[], []]);
      }
      inserts += 1;
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    };
    const connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute,
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentsService,
        {
          provide: MYSQL_POOL,
          useValue: { getConnection: () => Promise.resolve(connection) },
        },
        { provide: NotificationsService, useValue: {} },
        {
          provide: CommunityRuleAcceptanceService,
          useValue: { assertAcceptedOrThrow: assertAccepted },
        },
      ],
    }).compile();
    service = module.get(CommentsService);
  });

  // Both fixtures are also locked: the removal 409 comes first.
  it('refuses a comment on a removed post with 409', async () => {
    postRemoved = true;
    await expect(
      service.create('post-1', { content: 'Hi' }, 'member'),
    ).rejects.toMatchObject({
      status: 409,
      message:
        'This post was removed by a moderator; it accepts no new comments',
    });
    expect(inserts).toBe(0);
  });

  it('refuses a reply to a removed comment with 409', async () => {
    parentRemoved = 1;
    await expect(
      service.create(
        'post-1',
        { content: 'Hi', parent_id: 'parent-1' },
        'member',
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: 'The comment being replied to was removed by a moderator',
    });
    expect(assertAccepted).toHaveBeenCalledTimes(1);
  });
});
