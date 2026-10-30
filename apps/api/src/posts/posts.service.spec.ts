import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { COMMUNITY_NEW_POST_RECIPIENTS_SQL } from '../communities/community-notification-recipients';
import { NotificationsService } from '../notifications/notifications.service';
import { PostsService } from './posts.service';

describe('PostsService', () => {
  let service: PostsService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let results: unknown[];

  beforeEach(async () => {
    queries = [];
    results = [];
    // The pool and the transaction connection share one query log and one
    // result queue, so a test reads the same whichever of them a query uses.
    const execute = (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return Promise.resolve([results.shift() ?? [], []]);
    };
    const connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
      release: () => undefined,
      execute,
    };
    const pool = {
      execute,
      getConnection: () => Promise.resolve(connection),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PostsService,
        { provide: MYSQL_POOL, useValue: pool },
        {
          provide: NotificationsService,
          useValue: {
            recordCommunityPost: () =>
              Promise.resolve({ recipients: 0, written: false }),
          },
        },
      ],
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
});

describe('PostsService.create notifications', () => {
  const input = {
    title: ' Hello ',
    type: 'text' as const,
    content: ' World ',
    community_id: 'community-1',
  };
  const createdPost = {
    id: 'post-new',
    title: 'Hello',
    content: 'World',
    type: 'text',
    author_id: 'author',
    community_id: 'community-1',
    created_at: new Date('2026-10-30T08:00:00.000Z'),
  };

  let queries: Array<{ sql: string; values: unknown[] }>;
  let recipientCount: number;
  let failFanOut: boolean;
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  let warn: jest.SpiedFunction<Logger['warn']>;

  // Uses the real NotificationsService, so the statements it sends on the
  // post's connection are what is asserted.
  async function createService(): Promise<PostsService> {
    const pool = {
      execute: () =>
        Promise.reject(new Error('create must use its own connection')),
      getConnection: () => Promise.resolve(connection),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PostsService,
        NotificationsService,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();
    return module.get(PostsService);
  }

  beforeEach(() => {
    queries = [];
    recipientCount = 2;
    failFanOut = false;
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT id FROM communities')) {
          return Promise.resolve([
            values[0] === 'community-1' ? [{ id: 'community-1' }] : [],
            [],
          ]);
        }
        if (sql.startsWith('INSERT INTO posts')) {
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('SELECT id, title, content, type')) {
          return Promise.resolve([[{ ...createdPost, id: values[0] }], []]);
        }
        if (sql.startsWith('SELECT COUNT(*) AS recipients')) {
          return Promise.resolve([[{ recipients: recipientCount }], []]);
        }
        if (sql.startsWith('INSERT INTO notifications')) {
          return failFanOut
            ? Promise.reject(new Error('fan-out failed'))
            : Promise.resolve([{ affectedRows: recipientCount }, []]);
        }
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      },
    };
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    delete process.env.NOTIFICATION_FANOUT_MAX;
  });

  const notificationWrites = () =>
    queries.filter((query) =>
      query.sql.startsWith('INSERT INTO notifications'),
    );

  it('fans out to eligible members in one statement, inside the transaction', async () => {
    const service = await createService();

    const result = await service.create(input, 'author');

    const postId = result.id;
    expect(result).toEqual({
      ...createdPost,
      id: postId,
      created_at: '2026-10-30T08:00:00.000Z',
    });
    expect(queries[1].values[0]).toBe(postId);
    const count = queries.find((query) =>
      query.sql.startsWith('SELECT COUNT(*) AS recipients'),
    );
    expect(count?.sql).toContain(COMMUNITY_NEW_POST_RECIPIENTS_SQL);
    expect(count?.sql).toContain('AND s.user_id <> ?');
    expect(count?.values).toEqual(['community-1', 'author']);

    expect(notificationWrites()).toHaveLength(1);
    const [fanOut] = notificationWrites();
    expect(fanOut.sql).toContain(
      "SELECT UUID(), eligible.user_id, 'community_post', ?, 'post', ?, ?, ?",
    );
    expect(fanOut.sql).toContain(COMMUNITY_NEW_POST_RECIPIENTS_SQL);
    expect(fanOut.sql).toMatch(/ON DUPLICATE KEY UPDATE id = id$/);
    expect(fanOut.values).toEqual([
      'author',
      postId,
      'community-1',
      JSON.stringify({ post_title: 'Hello' }),
      'community-1',
      'author',
    ]);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the same number of statements however many members are notified', async () => {
    const service = await createService();
    await service.create(input, 'author');
    const small = queries.length;

    queries = [];
    recipientCount = 4999;
    await service.create(input, 'author');

    expect(queries).toHaveLength(small);
    expect(notificationWrites()).toHaveLength(1);
  });

  it('writes nothing when no member is eligible', async () => {
    recipientCount = 0;
    const service = await createService();

    await service.create(input, 'author');

    expect(notificationWrites()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(connection.commit).toHaveBeenCalledTimes(1);
  });

  it('skips and logs the fan-out above the ceiling, still creating the post', async () => {
    recipientCount = 5001;
    const service = await createService();

    const result = await service.create(input, 'author');

    expect(result.title).toBe('Hello');
    expect(notificationWrites()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('community community-1');
    expect(warn.mock.calls[0][0]).toContain('5001 eligible recipients');
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('fans out at exactly the ceiling, which NOTIFICATION_FANOUT_MAX configures', async () => {
    process.env.NOTIFICATION_FANOUT_MAX = '3';
    recipientCount = 3;
    const service = await createService();
    await service.create(input, 'author');
    expect(notificationWrites()).toHaveLength(1);

    queries = [];
    recipientCount = 4;
    await service.create(input, 'author');
    expect(notificationWrites()).toEqual([]);
    expect(warn.mock.calls[0][0]).toContain('NOTIFICATION_FANOUT_MAX (3)');
  });

  it('rolls the post back and releases when the fan-out fails', async () => {
    failFanOut = true;
    const service = await createService();

    await expect(service.create(input, 'author')).rejects.toThrow(
      'fan-out failed',
    );

    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('keeps its 404 and releases the connection on it', async () => {
    const service = await createService();

    await expect(
      service.create({ ...input, community_id: 'unknown' }, 'author'),
    ).rejects.toThrow(new NotFoundException('Community not found'));

    expect(queries.map((query) => query.sql)).toEqual([
      'SELECT id FROM communities WHERE id = ? LIMIT 1',
    ]);
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });
});

describe('PostsService.remove', () => {
  let service: PostsService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let post: Record<string, unknown> | undefined;
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  let notifications: { record: jest.Mock; recordCommunityPost: jest.Mock };

  beforeEach(async () => {
    queries = [];
    post = {
      id: 'post-1',
      author_id: 'author',
      community_id: 'community-1',
      title: 'Hello',
      can_moderate: 0,
    };
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT posts.id')) {
          return Promise.resolve([post ? [post] : [], []]);
        }
        if (sql.startsWith('DELETE FROM posts')) {
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      },
    };
    notifications = {
      record: jest.fn().mockResolvedValue(undefined),
      recordCommunityPost: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PostsService,
        {
          provide: MYSQL_POOL,
          useValue: { getConnection: () => Promise.resolve(connection) },
        },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(PostsService);
  });

  const deletes = () =>
    queries.filter((query) => query.sql.startsWith('DELETE FROM posts'));

  function expectCommittedAndReleased() {
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  }

  function expectRolledBackAndReleased() {
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  }

  it('locks and reads the post, deciding authorisation in the service', async () => {
    await service.remove('post-1', 'author');

    expect(queries[0].sql).toContain('FROM posts');
    expect(queries[0].sql).toContain('community_moderators');
    expect(queries[0].sql).toMatch(/FOR UPDATE$/);
    expect(queries[0].values).toEqual(['author', 'author', 'post-1']);
    expect(deletes()).toEqual([
      { sql: 'DELETE FROM posts WHERE id = ?', values: ['post-1'] },
    ]);
  });

  it('lets the author delete without a notification, even as a moderator', async () => {
    await expect(service.remove('post-1', 'author')).resolves.toBeUndefined();
    expectCommittedAndReleased();

    post = { ...post, can_moderate: 1 };
    await service.remove('post-1', 'author');

    expect(deletes()).toHaveLength(2);
    expect(notifications.record).not.toHaveBeenCalled();
  });

  it.each([1, '1', true])(
    'lets a moderator or creator delete and notifies the author (can_moderate %p)',
    async (canModerate) => {
      post = { ...post, can_moderate: canModerate };

      await expect(
        service.remove('post-1', 'moderator'),
      ).resolves.toBeUndefined();

      expect(deletes()).toHaveLength(1);
      expect(notifications.record).toHaveBeenCalledTimes(1);
      expect(notifications.record).toHaveBeenCalledWith(connection, {
        recipientId: 'author',
        type: 'content_removed',
        actorId: null,
        subjectType: 'post',
        subjectId: 'post-1',
        communityId: 'community-1',
        metadata: { post_title: 'Hello' },
      });
      expect(notifications.record.mock.invocationCallOrder[0]).toBeLessThan(
        connection.commit.mock.invocationCallOrder[0],
      );
      expectCommittedAndReleased();
    },
  );

  it('returns 403 to anyone else, including a moderator of another community', async () => {
    await expect(service.remove('post-1', 'stranger')).rejects.toThrow(
      new ForbiddenException(
        'You can only delete your own posts or moderate this community',
      ),
    );

    expect(deletes()).toEqual([]);
    expect(notifications.record).not.toHaveBeenCalled();
    expectRolledBackAndReleased();
  });

  it('returns 404 for a missing post', async () => {
    post = undefined;

    await expect(service.remove('missing', 'author')).rejects.toThrow(
      new NotFoundException('Post not found'),
    );

    expect(deletes()).toEqual([]);
    expectRolledBackAndReleased();
  });

  it('rolls the deletion back when the notification write fails', async () => {
    post = { ...post, can_moderate: 1 };
    notifications.record.mockRejectedValueOnce(new Error('insert failed'));

    await expect(service.remove('post-1', 'moderator')).rejects.toThrow(
      'insert failed',
    );

    expect(deletes()).toHaveLength(1);
    expectRolledBackAndReleased();
  });

  it('releases the connection when the transaction cannot start', async () => {
    connection.beginTransaction.mockRejectedValueOnce(new Error('no tx'));

    await expect(service.remove('post-1', 'author')).rejects.toThrow('no tx');

    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  });
});
