import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Pool } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { COMMUNITY_NEW_POST_RECIPIENTS_SQL } from '../communities/community-notification-recipients';
import { NotificationsService } from '../notifications/notifications.service';
import {
  INSERT_POST_REVISION_SQL,
  PostsService,
  POSTING_COMMUNITY_SQL,
} from './posts.service';
import { RELEASE_POST_MEDIA_SQL } from '../media/media-sql';

// Every community's rules count as accepted unless a test says otherwise.
const acceptingRuleAcceptance = {
  provide: CommunityRuleAcceptanceService,
  useValue: { assertAcceptedOrThrow: () => Promise.resolve() },
};

// The read, create and delete paths never write the moderation log.
const unusedModerationLog = {
  provide: CommunityModerationLogService,
  useValue: {
    record: () => Promise.reject(new Error('unexpected moderation log write')),
  },
};

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
      // The ban lookup is answered outside the queue: no ban here.
      if (sql.includes('FROM community_bans')) {
        return Promise.resolve([[], []] as [unknown, unknown]);
      }
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
        acceptingRuleAcceptance,
        unusedModerationLog,
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
    // A single-community listing floats that community's pins.
    expect(queries[0].sql).toContain(
      'ORDER BY (pinned_at IS NULL), pinned_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?',
    );
    expect(queries[0].values).toEqual(['community-1', null, 1, 1]);
    expect(queries[1].values).toEqual(['community-1', null]);
  });

  it('creates a post with the supplied author and community', async () => {
    results = [
      [
        {
          visibility: 'public',
          allowed_post_types: 'text,link,media',
          member: 1,
        },
      ],
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
      // No file: a text post (migration 035).
      null,
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
  // The community POST /posts reads (migration 038).
  let postingCommunity: {
    visibility: string;
    allowed_post_types: string;
    member: number;
  };
  const createdPost = {
    id: 'post-new',
    title: 'Hello',
    content: 'World',
    type: 'text',
    author_id: 'author',
    community_id: 'community-1',
    created_at: new Date('2026-10-30T08:00:00.000Z'),
    pinned_at: null,
    pinned_by: null,
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
        acceptingRuleAcceptance,
        unusedModerationLog,
        PostsService,
        NotificationsService,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();
    return module.get(PostsService);
  }

  beforeEach(() => {
    postingCommunity = {
      visibility: 'public',
      allowed_post_types: 'text,link,media',
      member: 1,
    };
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
        if (sql === POSTING_COMMUNITY_SQL) {
          return Promise.resolve([
            values[1] === 'community-1' ? [postingCommunity] : [],
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
        if (sql.startsWith('SELECT post_id FROM saved_posts')) {
          return Promise.resolve([[], []]);
        }
        // The ban lookup (CommunityBanPolicyService): no ban here.
        if (sql.includes('FROM community_bans')) {
          return Promise.resolve([[], []]);
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
      edited_at: null,
      locked_at: null,
      locked_by: null,
      score: 0,
      saved: false,
      media: null,
      flair: null,
      nsfw: false,
      spoiler: false,
    });
    expect(
      queries.find((query) => query.sql.startsWith('INSERT INTO posts'))
        ?.values[0],
    ).toBe(postId);
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

  // Migration 038: who may post where, and what.
  it.each(['restricted', 'private'])(
    'takes posts in a %s community from members only',
    async (visibility) => {
      postingCommunity = { ...postingCommunity, visibility, member: 1 };
      const service = await createService();
      await expect(service.create(input, 'author')).resolves.toBeDefined();
    },
  );

  it('answers a non-member 403 membership_required in a restricted community, writing nothing', async () => {
    postingCommunity = {
      ...postingCommunity,
      visibility: 'restricted',
      member: 0,
    };
    const service = await createService();

    await expect(service.create(input, 'author')).rejects.toMatchObject({
      status: 403,
      response: { reason: 'membership_required' },
    });
    expect(queries.some((q) => q.sql.startsWith('INSERT INTO posts'))).toBe(
      false,
    );
  });

  it('answers a non-member of a private community 404, as if it were not there', async () => {
    postingCommunity = {
      ...postingCommunity,
      visibility: 'private',
      member: 0,
    };
    const service = await createService();

    await expect(service.create(input, 'author')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a post type the community does not accept with 400', async () => {
    postingCommunity = {
      ...postingCommunity,
      allowed_post_types: 'link,media',
    };
    const service = await createService();

    await expect(service.create(input, 'author')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(queries.some((q) => q.sql.startsWith('INSERT INTO posts'))).toBe(
      false,
    );
  });

  it('keeps its 404 and releases the connection on it', async () => {
    const service = await createService();

    await expect(
      service.create({ ...input, community_id: 'unknown' }, 'author'),
    ).rejects.toThrow(new NotFoundException('Community not found'));

    expect(queries.map((query) => query.sql)).toEqual([POSTING_COMMUNITY_SQL]);
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
        // The post's file, released with it (migration 035).
        if (sql === RELEASE_POST_MEDIA_SQL) {
          return Promise.resolve([{ affectedRows: 0 }, []]);
        }
        if (sql.startsWith('SELECT post_id FROM saved_posts')) {
          return Promise.resolve([[], []]);
        }
        // The ban lookup (CommunityBanPolicyService): no ban here.
        if (sql.includes('FROM community_bans')) {
          return Promise.resolve([[], []]);
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
        acceptingRuleAcceptance,
        unusedModerationLog,
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
    // Its file is released first, in the same transaction.
    expect(queries.slice(1).map(({ sql }) => sql)).toEqual([
      RELEASE_POST_MEDIA_SQL,
      'DELETE FROM posts WHERE id = ?',
    ]);
    expect(queries[1].values).toEqual(['post-1']);
  });

  it('lets the author delete without a notification, even as a moderator', async () => {
    await expect(service.remove('post-1', 'author')).resolves.toBeUndefined();
    expectCommittedAndReleased();

    post = { ...post, can_moderate: 1 };
    await service.remove('post-1', 'author');

    expect(deletes()).toHaveLength(2);
    expect(notifications.record).not.toHaveBeenCalled();
  });

  // The breaking change, pinned: a moderator or the creator may no longer
  // hard-delete someone else's post. They are pointed at the reversible
  // POST /posts/:id/remove, and nothing is deleted or notified.
  it.each([1, '1', true])(
    'refuses a moderator or creator with 403 naming the remove route (can_moderate %p)',
    async (canModerate) => {
      post = { ...post, can_moderate: canModerate };

      await expect(service.remove('post-1', 'moderator')).rejects.toThrow(
        new ForbiddenException(
          'Only the author may delete this post; moderators remove posts with POST /posts/:id/remove',
        ),
      );

      expect(deletes()).toEqual([]);
      expect(notifications.record).not.toHaveBeenCalled();
      expectRolledBackAndReleased();
    },
  );

  it('returns 403 to anyone else, including a moderator of another community', async () => {
    await expect(service.remove('post-1', 'stranger')).rejects.toThrow(
      new ForbiddenException('You can only delete your own posts'),
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

  it('releases the connection when the transaction cannot start', async () => {
    connection.beginTransaction.mockRejectedValueOnce(new Error('no tx'));

    await expect(service.remove('post-1', 'author')).rejects.toThrow('no tx');

    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  });
});

describe('PostsService.findAll ordering', () => {
  let queries: Array<{ sql: string; values: unknown[] }>;
  let rows: unknown[];
  let service: PostsService;

  beforeEach(() => {
    queries = [];
    rows = [];
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return Promise.resolve([
          sql.startsWith('SELECT COUNT(*)') ? [{ total: rows.length }] : rows,
          [],
        ]);
      },
    };
    service = new PostsService(
      pool as unknown as Pool,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
      {} as CommunityModerationLogService,
    );
  });

  it("floats a single community's pins, most recently pinned first", async () => {
    await service.findAll({ community_id: 'community-1', page: 3, limit: 2 });

    expect(queries[0].sql).toMatch(
      / ORDER BY \(pinned_at IS NULL\), pinned_at DESC, created_at DESC, id DESC LIMIT \? OFFSET \?$/,
    );
    // The community, then the viewer (anonymous) of the readability check.
    expect(queries[0].values).toEqual(['community-1', null, 2, 4]);
    // The total counts pinned and unpinned posts alike.
    expect(queries[1].sql).not.toContain('pinned_at');
  });

  it('keeps the unfiltered feed in its previous order, without floating pins', async () => {
    await service.findAll({ page: 1, limit: 20 });

    expect(queries[0].sql).toMatch(
      / ORDER BY created_at DESC, id DESC LIMIT \? OFFSET \?$/,
    );
    expect(queries[0].sql).not.toContain('pinned_at IS NULL');
    expect(queries[0].values).toEqual([null, 20, 0]);
  });

  it('returns pinned_at and pinned_by on every post, null when unpinned', async () => {
    const row = {
      title: 'Hello',
      content: 'World',
      type: 'text',
      author_id: 'author',
      community_id: 'community-1',
      created_at: new Date('2026-10-22T08:00:00.000Z'),
    };
    rows = [
      {
        ...row,
        id: 'pinned',
        pinned_at: new Date('2026-11-01T09:00:00.000Z'),
        pinned_by: 'moderator',
      },
      // Pinned by a moderator whose account was since deleted.
      {
        ...row,
        id: 'orphaned',
        pinned_at: new Date('2026-11-01T08:00:00.000Z'),
        pinned_by: null,
      },
      { ...row, id: 'plain', pinned_at: null, pinned_by: null },
    ];

    const { items } = await service.findAll({ community_id: 'community-1' });

    expect(
      items.map(({ id, pinned_at, pinned_by }) => ({
        id,
        pinned_at,
        pinned_by,
      })),
    ).toEqual([
      {
        id: 'pinned',
        pinned_at: '2026-11-01T09:00:00.000Z',
        pinned_by: 'moderator',
      },
      {
        id: 'orphaned',
        pinned_at: '2026-11-01T08:00:00.000Z',
        pinned_by: null,
      },
      { id: 'plain', pinned_at: null, pinned_by: null },
    ]);
  });
});

interface StoredPost {
  id: string;
  author_id: string;
  community_id: string;
  pinned_at: Date | null;
  pinned_by: string | null;
  removed_at: Date | null;
}

// An in-memory posts table behind connections that model what pin and unpin
// rely on: FOR UPDATE on a communities row blocks until its holder commits or
// rolls back, and a rollback undoes only that connection's own writes.
function createPinStore() {
  const posts = new Map<string, StoredPost>();
  const creators = new Map([
    ['community-1', 'creator'],
    ['community-2', 'other-creator'],
  ]);
  const moderators = new Set([
    'community-1:moderator',
    'community-2:other-moderator',
  ]);
  const deletedCommunities = new Set<string>();
  const log: Array<{ connection: number; action: string; targetId: string }> =
    [];
  const queries: Array<{ connection: number; sql: string; values: unknown[] }> =
    [];
  const communityLocks = new Map<string, Promise<void>>();
  const hooks: {
    beforeCount?: (connection: number) => Promise<void>;
    // How the driver returns the EXISTS column.
    canModerate: (allowed: boolean) => unknown;
    failBegin: boolean;
    zeroAffectedPin: boolean;
  } = {
    canModerate: (allowed) => (allowed ? 1 : 0),
    failBegin: false,
    zeroAffectedPin: false,
  };
  let clock = Date.parse('2026-11-01T08:00:00.000Z');
  let nextConnection = 0;
  let open = 0;

  const addPost = (id: string, communityId = 'community-1') =>
    posts.set(id, {
      id,
      author_id: 'author',
      community_id: communityId,
      pinned_at: null,
      pinned_by: null,
      removed_at: null,
    });
  for (const id of ['post-1', 'post-2', 'post-3', 'post-4']) {
    addPost(id);
  }
  addPost('other-post', 'community-2');

  const connection = () => {
    const number = (nextConnection += 1);
    const undo: Array<() => void> = [];
    const releases: Array<() => void> = [];
    const unlock = () => releases.splice(0).forEach((release) => release());
    open += 1;

    const execute = async (
      sql: string,
      values: unknown[],
    ): Promise<[unknown, unknown]> => {
      queries.push({ connection: number, sql, values });
      if (sql.startsWith('SELECT posts.id, posts.community_id')) {
        const [creatorId, moderatorId, id] = values as string[];
        const post = posts.get(id);
        if (
          !post ||
          (sql.includes('deleted_at IS NULL') &&
            deletedCommunities.has(post.community_id))
        ) {
          return [[], []];
        }
        const allowed =
          creators.get(post.community_id) === creatorId ||
          moderators.has(`${post.community_id}:${moderatorId}`);
        return [
          [
            {
              id: post.id,
              community_id: post.community_id,
              pinned_at: post.pinned_at,
              removed_at: post.removed_at,
              can_moderate: hooks.canModerate(allowed),
            },
          ],
          [],
        ];
      }
      if (
        sql === 'SELECT id FROM communities WHERE id = ? LIMIT 1 FOR UPDATE'
      ) {
        const [id] = values as [string];
        while (communityLocks.has(id)) {
          await communityLocks.get(id);
        }
        let release!: () => void;
        communityLocks.set(
          id,
          new Promise<void>((resolve) => {
            release = () => {
              communityLocks.delete(id);
              resolve();
            };
          }),
        );
        releases.push(release);
        return [[{ id }], []];
      }
      if (sql.startsWith('SELECT COUNT(*) AS pinned FROM posts')) {
        await hooks.beforeCount?.(number);
        const [communityId] = values as [string];
        const pinned = [...posts.values()].filter(
          (post) => post.community_id === communityId && post.pinned_at,
        ).length;
        return [[{ pinned }], []];
      }
      if (sql.startsWith('UPDATE posts SET pinned_at = UTC_TIMESTAMP()')) {
        const [actorId, id] = values as [string, string];
        const post = posts.get(id);
        if (!post || post.pinned_at || hooks.zeroAffectedPin) {
          return [{ affectedRows: 0 }, []];
        }
        const previous = { ...post };
        undo.push(() => posts.set(id, previous));
        clock += 60_000;
        posts.set(id, {
          ...post,
          pinned_at: new Date(clock),
          pinned_by: actorId,
        });
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('UPDATE posts SET pinned_at = NULL')) {
        const [id] = values as [string];
        const post = posts.get(id);
        if (!post || !post.pinned_at) {
          return [{ affectedRows: 0 }, []];
        }
        const previous = { ...post };
        undo.push(() => posts.set(id, previous));
        posts.set(id, { ...post, pinned_at: null, pinned_by: null });
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('SELECT id, title, content, type')) {
        const post = posts.get(values[0] as string);
        return [
          post
            ? [
                {
                  id: post.id,
                  title: 'Title',
                  content: 'Body',
                  type: 'text',
                  author_id: post.author_id,
                  community_id: post.community_id,
                  created_at: new Date('2026-10-22T08:00:00.000Z'),
                  pinned_at: post.pinned_at,
                  pinned_by: post.pinned_by,
                },
              ]
            : [],
          [],
        ];
      }
      if (sql.startsWith('SELECT target_id, SUM(value) AS score')) {
        return [[], []];
      }
      if (sql.startsWith('SELECT post_id FROM saved_posts')) {
        return [[], []];
      }
      // The ban lookup (CommunityBanPolicyService): no ban here.
      if (sql.includes('FROM community_bans')) {
        return [[], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };

    return {
      number,
      execute,
      beginTransaction: jest.fn(() =>
        hooks.failBegin
          ? Promise.reject(new Error('no tx'))
          : Promise.resolve(),
      ),
      commit: jest.fn(() => {
        undo.length = 0;
        unlock();
        return Promise.resolve();
      }),
      rollback: jest.fn(() => {
        undo
          .splice(0)
          .reverse()
          .forEach((step) => step());
        for (let i = log.length - 1; i >= 0; i -= 1) {
          if (log[i].connection === number) {
            log.splice(i, 1);
          }
        }
        unlock();
        return Promise.resolve();
      }),
      release: jest.fn(() => {
        open -= 1;
      }),
    };
  };

  return {
    posts,
    addPost,
    deletedCommunities,
    log,
    queries,
    hooks,
    connection,
    openConnections: () => open,
  };
}

describe('PostsService.pin and unpin', () => {
  let store: ReturnType<typeof createPinStore>;
  let connections: ReturnType<
    ReturnType<typeof createPinStore>['connection']
  >[];
  let moderationLog: { record: jest.Mock };
  let service: PostsService;

  const createService = () => {
    const pool = {
      execute: () =>
        Promise.reject(new Error('pinning must use one connection')),
      getConnection: () => {
        const connection = store.connection();
        connections.push(connection);
        return Promise.resolve(connection);
      },
    };
    return new PostsService(
      pool as unknown as Pool,
      {} as NotificationsService,
      {} as CommunityRuleAcceptanceService,
      moderationLog as unknown as CommunityModerationLogService,
    );
  };

  beforeEach(() => {
    store = createPinStore();
    connections = [];
    moderationLog = {
      record: jest.fn(
        (
          connection: { number: number },
          entry: { action: string; targetId: string },
        ) => {
          store.log.push({
            connection: connection.number,
            action: entry.action,
            targetId: entry.targetId,
          });
          return Promise.resolve();
        },
      ),
    };
    service = createService();
  });

  afterEach(() => {
    delete process.env.COMMUNITY_PINNED_POSTS_MAX;
  });

  const lastConnection = () => connections[connections.length - 1];

  function expectCommittedAndReleased() {
    const connection = lastConnection();
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  }

  function expectRolledBackAndReleased() {
    const connection = lastConnection();
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  }

  const pinWrites = () =>
    store.queries.filter(({ sql }) => sql.startsWith('UPDATE posts'));

  describe('pin', () => {
    it('locks and reads the post, deciding moderation rights in the service', async () => {
      await service.pin('post-1', 'moderator');

      const [read] = store.queries;
      expect(read.sql).toMatch(/^SELECT posts\.id, posts\.community_id/);
      expect(read.sql).toContain('community_moderators');
      expect(read.sql).toContain('deleted_at IS NULL');
      expect(read.sql).toMatch(/FOR UPDATE$/);
      expect(read.values).toEqual(['moderator', 'moderator', 'post-1']);
    });

    it.each([
      ['the community creator', 'creator'],
      ['a community moderator', 'moderator'],
    ])(
      'lets %s pin, from the database clock and the token',
      async (_who, actor) => {
        const result = await service.pin('post-1', actor);

        expect(result).toMatchObject({
          id: 'post-1',
          pinned_at: '2026-11-01T08:01:00.000Z',
          pinned_by: actor,
        });
        expect(pinWrites()).toEqual([
          {
            connection: 1,
            sql: 'UPDATE posts SET pinned_at = UTC_TIMESTAMP(), pinned_by = ? WHERE id = ? AND pinned_at IS NULL',
            values: [actor, 'post-1'],
          },
        ]);
        expect(moderationLog.record).toHaveBeenCalledTimes(1);
        expect(moderationLog.record).toHaveBeenCalledWith(lastConnection(), {
          actorId: actor,
          communityId: 'community-1',
          action: 'post_pinned',
          targetType: 'post',
          targetId: 'post-1',
        });
        expect(moderationLog.record.mock.invocationCallOrder[0]).toBeLessThan(
          lastConnection().commit.mock.invocationCallOrder[0],
        );
        expectCommittedAndReleased();
      },
    );

    it.each([1, '1', true])(
      'reads can_moderate through isSqlTrue (%p)',
      async (value) => {
        store.hooks.canModerate = (allowed) => (allowed ? value : 0);
        await expect(service.pin('post-1', 'moderator')).resolves.toMatchObject(
          { pinned_by: 'moderator' },
        );
      },
    );

    it.each([0, '0', false])(
      'treats can_moderate %p as not moderating',
      async (value) => {
        store.hooks.canModerate = () => value;
        await expect(service.pin('post-1', 'moderator')).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      },
    );

    it.each([
      ['the post author, who moderates nothing', 'author'],
      ['any other member', 'stranger'],
      ['a moderator of a different community', 'other-moderator'],
      ['the creator of a different community', 'other-creator'],
    ])('returns 403 to %s and pins nothing', async (_who, actor) => {
      await expect(service.pin('post-1', actor)).rejects.toThrow(
        new ForbiddenException(
          'Only the community creator and moderators can pin or unpin posts',
        ),
      );

      expect(pinWrites()).toEqual([]);
      expect(store.posts.get('post-1')?.pinned_at).toBeNull();
      expect(moderationLog.record).not.toHaveBeenCalled();
      expectRolledBackAndReleased();
    });

    it('returns 404 for an unknown post and for a post in a deleted community', async () => {
      await expect(service.pin('missing', 'moderator')).rejects.toThrow(
        new NotFoundException('Post not found'),
      );
      expectRolledBackAndReleased();

      store.deletedCommunities.add('community-1');
      await expect(service.pin('post-1', 'creator')).rejects.toThrow(
        new NotFoundException('Post not found'),
      );
      expectRolledBackAndReleased();
      expect(pinWrites()).toEqual([]);
    });

    it('returns 409 for a post removed by a moderator', async () => {
      const post = store.posts.get('post-1')!;
      store.posts.set('post-1', { ...post, removed_at: new Date() });

      await expect(service.pin('post-1', 'moderator')).rejects.toThrow(
        new ConflictException('A removed post cannot be pinned'),
      );

      expect(pinWrites()).toEqual([]);
      expectRolledBackAndReleased();
    });

    it('is idempotent: a second pin returns the post unchanged, keeping pinned_at', async () => {
      const first = await service.pin('post-1', 'moderator');
      const second = await service.pin('post-1', 'creator');

      expect(second).toEqual(first);
      expect(second.pinned_by).toBe('moderator');
      expect(pinWrites()).toHaveLength(1);
      expect(store.log).toEqual([
        { connection: 1, action: 'post_pinned', targetId: 'post-1' },
      ]);
      expectCommittedAndReleased();
    });

    it('treats a guarded UPDATE that affects no row as already pinned, logging nothing', async () => {
      store.hooks.zeroAffectedPin = true;

      const result = await service.pin('post-1', 'moderator');

      expect(result.id).toBe('post-1');
      expect(moderationLog.record).not.toHaveBeenCalled();
      expectCommittedAndReleased();
    });

    it('counts pins after locking the community, as a locking read on the same connection', async () => {
      await service.pin('post-1', 'moderator');

      const sql = store.queries.map((query) => query.sql);
      const lock = sql.indexOf(
        'SELECT id FROM communities WHERE id = ? LIMIT 1 FOR UPDATE',
      );
      const count = sql.findIndex((statement) =>
        statement.startsWith('SELECT COUNT(*) AS pinned FROM posts'),
      );
      const update = sql.findIndex((statement) =>
        statement.startsWith('UPDATE posts SET pinned_at'),
      );
      expect(lock).toBe(1);
      expect(store.queries[lock].values).toEqual(['community-1']);
      expect(count).toBeGreaterThan(lock);
      expect(update).toBeGreaterThan(count);
      expect(sql[count]).toBe(
        'SELECT COUNT(*) AS pinned FROM posts WHERE community_id = ? AND pinned_at IS NOT NULL FOR SHARE',
      );
      expect(store.queries[count].values).toEqual(['community-1']);
      expect(store.queries.every(({ connection }) => connection === 1)).toBe(
        true,
      );
    });

    it('returns 409 naming the limit at COMMUNITY_PINNED_POSTS_MAX, pinning nothing', async () => {
      process.env.COMMUNITY_PINNED_POSTS_MAX = '2';
      service = createService();
      await service.pin('post-1', 'moderator');
      await service.pin('post-2', 'moderator');

      await expect(service.pin('post-3', 'moderator')).rejects.toThrow(
        new ConflictException('A community can have at most 2 pinned posts'),
      );

      expect(store.posts.get('post-3')?.pinned_at).toBeNull();
      expect(store.log.map(({ targetId }) => targetId)).toEqual([
        'post-1',
        'post-2',
      ]);
      expectRolledBackAndReleased();
      // Another community's pins do not count against this one's cap.
      await expect(
        service.pin('other-post', 'other-moderator'),
      ).resolves.toMatchObject({ pinned_by: 'other-moderator' });
    });

    it('still answers 200 for an already-pinned post when the community is at the cap', async () => {
      process.env.COMMUNITY_PINNED_POSTS_MAX = '1';
      service = createService();
      const first = await service.pin('post-1', 'moderator');

      await expect(service.pin('post-1', 'moderator')).resolves.toEqual(first);
      expectCommittedAndReleased();
    });

    it('defaults the cap to 5', async () => {
      store.addPost('post-5');
      store.addPost('post-6');
      for (const id of ['post-1', 'post-2', 'post-3', 'post-4', 'post-5']) {
        await service.pin(id, 'moderator');
      }

      await expect(service.pin('post-6', 'moderator')).rejects.toThrow(
        new ConflictException('A community can have at most 5 pinned posts'),
      );
    });

    it('lets exactly one of two concurrent pins at the cap boundary succeed', async () => {
      process.env.COMMUNITY_PINNED_POSTS_MAX = '2';
      service = createService();
      await service.pin('post-1', 'moderator');

      // While the first request sits between its count and its update, a
      // competing request pins another post of the same community.
      let second: Promise<{ ok?: unknown; error?: unknown }> | undefined;
      store.hooks.beforeCount = (connection) => {
        if (connection !== 2) {
          return Promise.resolve();
        }
        second = service.pin('post-3', 'creator').then(
          (ok) => ({ ok }),
          (error: unknown) => ({ error }),
        );
        // Let the competitor run as far as it can before continuing.
        return new Promise((resolve) => setTimeout(resolve, 10));
      };

      const first = await service.pin('post-2', 'moderator');
      const outcome = await second;

      expect(first.pinned_by).toBe('moderator');
      expect(outcome).toEqual({
        error: new ConflictException(
          'A community can have at most 2 pinned posts',
        ),
      });
      expect(
        [...store.posts.values()]
          .filter((post) => post.pinned_at)
          .map((post) => post.id)
          .sort(),
      ).toEqual(['post-1', 'post-2']);
      expect(store.log.map(({ targetId }) => targetId)).toEqual([
        'post-1',
        'post-2',
      ]);
      expect(store.openConnections()).toBe(0);
    });

    it('rolls the pin back and releases when the log write fails', async () => {
      moderationLog.record.mockRejectedValueOnce(new Error('log failed'));

      await expect(service.pin('post-1', 'moderator')).rejects.toThrow(
        'log failed',
      );

      expect(pinWrites()).toHaveLength(1);
      expect(store.posts.get('post-1')).toMatchObject({
        pinned_at: null,
        pinned_by: null,
      });
      expectRolledBackAndReleased();
    });

    it('releases the connection when the transaction cannot start', async () => {
      store.hooks.failBegin = true;

      await expect(service.pin('post-1', 'moderator')).rejects.toThrow('no tx');

      expect(lastConnection().rollback).not.toHaveBeenCalled();
      expect(lastConnection().release).toHaveBeenCalledTimes(1);
    });
  });

  describe('unpin', () => {
    beforeEach(async () => {
      await service.pin('post-1', 'moderator');
      store.queries.length = 0;
      store.log.length = 0;
      moderationLog.record.mockClear();
    });

    it('clears both columns and logs post_unpinned inside the transaction', async () => {
      await expect(service.unpin('post-1', 'creator')).resolves.toBeUndefined();

      expect(store.queries[0].sql).toMatch(/FOR UPDATE$/);
      expect(store.queries[0].values).toEqual(['creator', 'creator', 'post-1']);
      expect(pinWrites()).toEqual([
        {
          connection: 2,
          sql: 'UPDATE posts SET pinned_at = NULL, pinned_by = NULL WHERE id = ? AND pinned_at IS NOT NULL',
          values: ['post-1'],
        },
      ]);
      expect(store.posts.get('post-1')).toMatchObject({
        pinned_at: null,
        pinned_by: null,
      });
      expect(moderationLog.record).toHaveBeenCalledTimes(1);
      expect(moderationLog.record).toHaveBeenCalledWith(lastConnection(), {
        actorId: 'creator',
        communityId: 'community-1',
        action: 'post_unpinned',
        targetType: 'post',
        targetId: 'post-1',
      });
      expectCommittedAndReleased();
    });

    it('is idempotent: unpinning an unpinned post succeeds and logs nothing', async () => {
      await service.unpin('post-1', 'moderator');
      await expect(
        service.unpin('post-1', 'moderator'),
      ).resolves.toBeUndefined();
      expectCommittedAndReleased();
      await expect(
        service.unpin('post-2', 'moderator'),
      ).resolves.toBeUndefined();
      expectCommittedAndReleased();

      expect(store.log).toEqual([
        { connection: 2, action: 'post_unpinned', targetId: 'post-1' },
      ]);
    });

    it.each([
      ['the post author', 'author'],
      ['any other member', 'stranger'],
      ['a moderator of a different community', 'other-moderator'],
    ])('returns 403 to %s and keeps the pin', async (_who, actor) => {
      await expect(service.unpin('post-1', actor)).rejects.toThrow(
        new ForbiddenException(
          'Only the community creator and moderators can pin or unpin posts',
        ),
      );

      expect(pinWrites()).toEqual([]);
      expect(store.posts.get('post-1')?.pinned_by).toBe('moderator');
      expectRolledBackAndReleased();
    });

    it('returns 404 for an unknown post', async () => {
      await expect(service.unpin('missing', 'moderator')).rejects.toThrow(
        new NotFoundException('Post not found'),
      );
      expectRolledBackAndReleased();
    });

    it('rolls the unpin back when the log write fails', async () => {
      moderationLog.record.mockRejectedValueOnce(new Error('log failed'));

      await expect(service.unpin('post-1', 'moderator')).rejects.toThrow(
        'log failed',
      );

      expect(store.posts.get('post-1')?.pinned_by).toBe('moderator');
      expectRolledBackAndReleased();
    });
  });
});

describe('PostsService.update', () => {
  type StoredPost = {
    id: string;
    author_id: string;
    type: 'text' | 'link' | 'media';
    title: string;
    content: string;
    community_id: string;
    created_at: Date;
    locked_at: Date | null;
    removed_at: Date | null;
    edited_at: Date | null;
    media_id?: string | null;
  };
  let service: PostsService;
  let posts: Map<string, StoredPost>;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let hidden: boolean;
  let failUpdate: boolean;
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  const clock = new Date('2026-11-05T12:00:00.000Z');

  const addPost = (
    id: string,
    type: StoredPost['type'],
    content: string,
    overrides: Partial<StoredPost> = {},
  ) =>
    posts.set(id, {
      id,
      author_id: 'author',
      type,
      title: 'Title',
      content,
      community_id: 'community-1',
      created_at: new Date('2026-10-22T08:00:00.000Z'),
      locked_at: null,
      removed_at: null,
      edited_at: null,
      ...overrides,
    });

  let revisions: unknown[][];

  beforeEach(async () => {
    posts = new Map();
    queries = [];
    revisions = [];
    hidden = false;
    failUpdate = false;
    addPost('text-post', 'text', 'Body');
    addPost('link-post', 'link', 'https://example.com/a');
    // A media post from before uploads: its content is its URL.
    addPost('media-post', 'media', 'https://example.com/a.png');
    // A media post with an uploaded file: its content is a caption.
    addPost('upload-post', 'media', 'A caption', { media_id: 'media-1' });
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT id, author_id, type, title, content')) {
          const post = posts.get(values[0] as string);
          return Promise.resolve([post && !hidden ? [{ ...post }] : [], []]);
        }
        // The replaced version (migration 039).
        if (sql === INSERT_POST_REVISION_SQL) {
          revisions.push(values);
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('UPDATE posts SET')) {
          if (failUpdate) {
            return Promise.reject(new Error('write failed'));
          }
          const id = values[values.length - 1] as string;
          const post = posts.get(id)!;
          const columns = [...sql.matchAll(/(title|content) = \?/g)].map(
            (match) => match[1] as 'title' | 'content',
          );
          columns.forEach((column, index) => {
            post[column] = values[index] as string;
          });
          post.edited_at = clock;
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('SELECT id, title, content, type')) {
          const post = posts.get(values[0] as string);
          return Promise.resolve([
            post ? [{ ...post, pinned_at: null, pinned_by: null }] : [],
            [],
          ]);
        }
        if (sql.startsWith('SELECT target_id, SUM(value) AS score')) {
          return Promise.resolve([[{ target_id: values[1], score: 4 }], []]);
        }
        // The uploaded file of upload-post.
        if (sql.startsWith('SELECT media.id, media.uploader_id')) {
          return Promise.resolve([[], []]);
        }
        if (sql.startsWith('SELECT post_id FROM saved_posts')) {
          return Promise.resolve([[], []]);
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
        PostsService,
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
        unusedModerationLog,
      ],
    }).compile();
    service = module.get(PostsService);
  });

  const updates = () =>
    queries.filter(({ sql }) => sql.startsWith('UPDATE posts'));
  const expectCommittedAndReleased = () => {
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  };
  const expectRolledBackAndReleased = () => {
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(updates()).toHaveLength(0);
  };

  it('locks the row first, excluding deleted and suspended communities', async () => {
    await service.update('text-post', { title: 'New' }, 'author');
    const [read] = queries;
    expect(read.values).toEqual(['text-post']);
    expect(read.sql).toContain('FOR UPDATE');
    expect(read.sql).toContain(
      'communities.deleted_at IS NULL AND communities.suspended_at IS NULL',
    );
    expect(read.sql).toContain('communities.suspended_at IS NULL');
  });

  it('updates only the title, keeping content, id and created_at, and stamps edited_at', async () => {
    const result = await service.update(
      'text-post',
      { title: 'New title' },
      'author',
    );
    expect(updates()).toEqual([
      {
        sql: 'UPDATE posts SET title = ?, edited_at = UTC_TIMESTAMP() WHERE id = ?',
        values: ['New title', 'text-post'],
      },
    ]);
    expect(result).toMatchObject({
      id: 'text-post',
      title: 'New title',
      content: 'Body',
      created_at: '2026-10-22T08:00:00.000Z',
      edited_at: clock.toISOString(),
      locked_at: null,
      locked_by: null,
      score: 4,
    });
    expectCommittedAndReleased();
  });

  // Migration 039: GET /posts/:id/revisions.
  it('keeps the replaced version, with when it was written, before the update', async () => {
    await service.update('text-post', { title: 'New title' }, 'author');
    expect(revisions).toEqual([
      [
        expect.any(String),
        'text-post',
        'Title',
        'Body',
        new Date('2026-10-22T08:00:00.000Z'),
      ],
    ]);
    const order = queries.map(({ sql }) => sql);
    expect(order.indexOf(INSERT_POST_REVISION_SQL)).toBeLessThan(
      order.findIndex((sql) => sql.startsWith('UPDATE posts')),
    );

    // A later edit stores the edited version, dated by its edit.
    await service.update('text-post', { content: 'Body 2' }, 'author');
    expect(revisions[1].slice(2)).toEqual(['New title', 'Body', clock]);
  });

  it('stores no version when nothing changed', async () => {
    await service.update('text-post', { title: 'Title' }, 'author');
    expect(revisions).toEqual([]);
  });

  it('updates only the content, or both, with a dynamic SET list', async () => {
    await service.update('text-post', { content: 'New body' }, 'author');
    await service.update(
      'link-post',
      { title: 'T2', content: 'https://example.com/b' },
      'author',
    );
    expect(updates().map(({ sql }) => sql)).toEqual([
      'UPDATE posts SET content = ?, edited_at = UTC_TIMESTAMP() WHERE id = ?',
      'UPDATE posts SET title = ?, content = ?, edited_at = UTC_TIMESTAMP() WHERE id = ?',
    ]);
    expect(updates()[1].values).toEqual([
      'T2',
      'https://example.com/b',
      'link-post',
    ]);
  });

  it('writes only the fields that changed', async () => {
    await service.update(
      'text-post',
      { title: 'Title', content: 'Changed' },
      'author',
    );
    expect(updates()[0].sql).toBe(
      'UPDATE posts SET content = ?, edited_at = UTC_TIMESTAMP() WHERE id = ?',
    );
  });

  it('skips the write for identical values, leaving edited_at null', async () => {
    const result = await service.update(
      'text-post',
      { title: 'Title', content: 'Body' },
      'author',
    );
    expect(updates()).toHaveLength(0);
    expect(result.edited_at).toBeNull();
    expectCommittedAndReleased();
  });

  it.each(['moderator', 'creator-1', 'stranger'])(
    'refuses %s with 403, writing nothing',
    async (actor) => {
      await expect(
        service.update('text-post', { title: 'Hijack' }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expectRolledBackAndReleased();
    },
  );

  it('answers 404 for an unknown post or one in a hidden community', async () => {
    await expect(
      service.update('missing', { title: 'T' }, 'author'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expectRolledBackAndReleased();

    hidden = true;
    connection.rollback.mockClear();
    connection.release.mockClear();
    await expect(
      service.update('text-post', { title: 'T' }, 'author'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a removed post with 409 after the author check', async () => {
    addPost('removed', 'text', 'Body', { removed_at: clock });
    await expect(
      service.update('removed', { title: 'T' }, 'stranger'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    connection.rollback.mockClear();
    connection.release.mockClear();
    await expect(
      service.update('removed', { title: 'T' }, 'author'),
    ).rejects.toBeInstanceOf(ConflictException);
    expectRolledBackAndReleased();
  });

  it('lets the author edit their own locked post', async () => {
    addPost('locked', 'text', 'Body', { locked_at: clock });
    await expect(
      service.update('locked', { content: 'Corrected' }, 'author'),
    ).resolves.toMatchObject({ content: 'Corrected' });
  });

  describe('validates content against the stored type', () => {
    it('accepts arbitrary text on a text post', async () => {
      await expect(
        service.update('text-post', { content: 'not a url at all' }, 'author'),
      ).resolves.toMatchObject({ content: 'not a url at all' });
    });

    it.each(['link-post', 'media-post'])(
      'accepts an HTTP(S) URL on a %s',
      async (id) => {
        await expect(
          service.update(id, { content: 'http://example.org/x' }, 'author'),
        ).resolves.toMatchObject({ content: 'http://example.org/x' });
      },
    );

    it.each([
      ['link-post', 'just some text'],
      ['link-post', 'https://user:secret@example.com/'],
      ['link-post', 'ftp://example.com/file'],
      ['link-post', 'javascript:alert(1)'],
      ['link-post', 'https://example.com\\evil'],
      ['media-post', 'https://example.com/a\u0007.png'],
      ['media-post', 'not-a-url.png'],
    ])('refuses on %s: %j, with 400', async (id, content) => {
      await expect(
        service.update(id, { content }, 'author'),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          message: [
            'content must be an HTTP or HTTPS URL for link and media posts',
          ],
        },
      });
      expectRolledBackAndReleased();
    });

    it('takes any caption on a media post with an uploaded file', async () => {
      await expect(
        service.update(
          'upload-post',
          { content: 'not a url at all' },
          'author',
        ),
      ).resolves.toMatchObject({ content: 'not a url at all' });
    });

    it('does not check a title-only edit of a link post against the URL rule', async () => {
      await expect(
        service.update('link-post', { title: 'Plain title' }, 'author'),
      ).resolves.toMatchObject({ title: 'Plain title' });
    });
  });

  it('rolls back and releases when the write fails', async () => {
    failUpdate = true;
    await expect(
      service.update('text-post', { title: 'T' }, 'author'),
    ).rejects.toThrow('write failed');
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });
});

describe('PostsService.lock and unlock', () => {
  type StoredPost = {
    id: string;
    author_id: string;
    community_id: string;
    locked_at: Date | null;
    locked_by: string | null;
    removed_at: Date | null;
  };
  let service: PostsService;
  let posts: Map<string, StoredPost>;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let log: { record: jest.Mock };
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  const clock = new Date('2026-11-06T09:00:00.000Z');
  // community-1 is created by creator-1 and moderated by moderator.
  const canModerate = (actor: unknown) =>
    actor === 'creator-1' || actor === 'moderator';

  beforeEach(async () => {
    queries = [];
    posts = new Map([
      [
        'post-1',
        {
          id: 'post-1',
          author_id: 'author',
          community_id: 'community-1',
          locked_at: null,
          locked_by: null,
          removed_at: null,
        },
      ],
    ]);
    log = { record: jest.fn().mockResolvedValue(undefined) };
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values });
        if (
          sql.startsWith('SELECT posts.id, posts.community_id, posts.locked_at')
        ) {
          const post = posts.get(values[2] as string);
          return Promise.resolve([
            post
              ? [{ ...post, can_moderate: canModerate(values[0]) ? 1 : 0 }]
              : [],
            [],
          ]);
        }
        if (sql.startsWith('UPDATE posts SET locked_at')) {
          const locking = sql.includes('UTC_TIMESTAMP()');
          const id = values[values.length - 1] as string;
          const post = posts.get(id)!;
          if (Boolean(post.locked_at) === locking) {
            return Promise.resolve([{ affectedRows: 0 }, []]);
          }
          posts.set(id, {
            ...post,
            locked_at: locking ? clock : null,
            locked_by: locking ? (values[0] as string) : null,
          });
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('SELECT id, title, content, type')) {
          const post = posts.get(values[0] as string)!;
          return Promise.resolve([
            [
              {
                ...post,
                title: 'Title',
                content: 'Body',
                type: 'text',
                created_at: new Date('2026-10-22T08:00:00.000Z'),
                pinned_at: null,
                pinned_by: null,
                edited_at: null,
              },
            ],
            [],
          ]);
        }
        if (sql.startsWith('SELECT target_id, SUM(value) AS score')) {
          return Promise.resolve([[], []]);
        }
        if (sql.startsWith('SELECT post_id FROM saved_posts')) {
          return Promise.resolve([[], []]);
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
        PostsService,
        {
          provide: MYSQL_POOL,
          useValue: { getConnection: () => Promise.resolve(connection) },
        },
        { provide: NotificationsService, useValue: {} },
        acceptingRuleAcceptance,
        { provide: CommunityModerationLogService, useValue: log },
      ],
    }).compile();
    service = module.get(PostsService);
  });

  const writes = () =>
    queries.filter(({ sql }) => sql.startsWith('UPDATE posts'));
  const expectCommittedAndReleased = () => {
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  };
  const expectRolledBackAndReleased = () => {
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  };

  it('reads the post FOR UPDATE with the moderation check bound to the actor', async () => {
    await service.lock('post-1', 'moderator');
    expect(queries[0].values).toEqual(['moderator', 'moderator', 'post-1']);
    expect(queries[0].sql).toContain('FOR UPDATE');
    expect(queries[0].sql).toContain('community_moderators');
  });

  it.each(['moderator', 'creator-1'])(
    'lets %s lock, from the database clock and the token, logging post_locked',
    async (actor) => {
      const result = await service.lock('post-1', actor);
      expect(writes()).toEqual([
        {
          sql: 'UPDATE posts SET locked_at = UTC_TIMESTAMP(), locked_by = ? WHERE id = ? AND locked_at IS NULL',
          values: [actor, 'post-1'],
        },
      ]);
      expect(result).toMatchObject({
        id: 'post-1',
        locked_at: clock.toISOString(),
        locked_by: actor,
      });
      expect(log.record).toHaveBeenCalledTimes(1);
      expect(log.record).toHaveBeenCalledWith(connection, {
        actorId: actor,
        communityId: 'community-1',
        action: 'post_locked',
        targetType: 'post',
        targetId: 'post-1',
      });
      expectCommittedAndReleased();
    },
  );

  it('is idempotent: locking a locked post keeps locked_at and logs nothing', async () => {
    const earlier = new Date('2026-11-01T00:00:00.000Z');
    posts.set('post-1', {
      ...posts.get('post-1')!,
      locked_at: earlier,
      locked_by: 'creator-1',
    });
    const result = await service.lock('post-1', 'moderator');
    expect(result).toMatchObject({
      locked_at: earlier.toISOString(),
      locked_by: 'creator-1',
    });
    expect(log.record).not.toHaveBeenCalled();
    expectCommittedAndReleased();
  });

  it('renders a lock by a since-deleted moderator with locked_by null', async () => {
    posts.set('post-1', {
      ...posts.get('post-1')!,
      locked_at: clock,
      locked_by: null,
    });
    await expect(service.lock('post-1', 'moderator')).resolves.toMatchObject({
      locked_at: clock.toISOString(),
      locked_by: null,
    });
  });

  it('unlocks, clearing both columns and logging post_unlocked', async () => {
    await service.lock('post-1', 'moderator');
    log.record.mockClear();
    connection.commit.mockClear();
    connection.release.mockClear();

    await service.unlock('post-1', 'creator-1');
    expect(writes()[1]).toEqual({
      sql: 'UPDATE posts SET locked_at = NULL, locked_by = NULL WHERE id = ? AND locked_at IS NOT NULL',
      values: ['post-1'],
    });
    expect(posts.get('post-1')).toMatchObject({
      locked_at: null,
      locked_by: null,
    });
    expect(log.record).toHaveBeenCalledWith(connection, {
      actorId: 'creator-1',
      communityId: 'community-1',
      action: 'post_unlocked',
      targetType: 'post',
      targetId: 'post-1',
    });
    expectCommittedAndReleased();
  });

  it('is idempotent: unlocking an unlocked post logs nothing', async () => {
    await service.unlock('post-1', 'moderator');
    expect(log.record).not.toHaveBeenCalled();
    expectCommittedAndReleased();
  });

  describe.each([
    ['lock', (s: PostsService, actor: string) => s.lock('post-1', actor)],
    ['unlock', (s: PostsService, actor: string) => s.unlock('post-1', actor)],
  ] as const)('%s', (_name, run) => {
    it.each(['author', 'stranger', 'moderator-elsewhere'])(
      'refuses %s with 403: authorship is not enough',
      async (actor) => {
        await expect(run(service, actor)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(writes()).toHaveLength(0);
        expectRolledBackAndReleased();
      },
    );

    it('answers 404 for an unknown post', async () => {
      posts.clear();
      await expect(run(service, 'moderator')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expectRolledBackAndReleased();
    });

    it('answers 409 for a removed post, writing nothing', async () => {
      posts.set('post-1', { ...posts.get('post-1')!, removed_at: clock });
      await expect(run(service, 'moderator')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(writes()).toHaveLength(0);
      expectRolledBackAndReleased();
    });
  });

  it('rolls the lock back when the log write fails', async () => {
    log.record.mockRejectedValueOnce(new Error('log failed'));
    await expect(service.lock('post-1', 'moderator')).rejects.toThrow(
      'log failed',
    );
    expectRolledBackAndReleased();
  });

  it('rolls the unlock back when the log write fails', async () => {
    posts.set('post-1', {
      ...posts.get('post-1')!,
      locked_at: clock,
      locked_by: 'moderator',
    });
    log.record.mockRejectedValueOnce(new Error('log failed'));
    await expect(service.unlock('post-1', 'moderator')).rejects.toThrow(
      'log failed',
    );
    expectRolledBackAndReleased();
  });
});

describe('PostsService moderative removal', () => {
  type StoredPost = {
    id: string;
    author_id: string;
    community_id: string;
    title: string;
    removed_at: Date | null;
    removed_by: string | null;
    removal_reason: string | null;
  };
  let service: PostsService;
  let post: StoredPost | undefined;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let notifications: { record: jest.Mock };
  let log: { record: jest.Mock };
  let assertAccepted: jest.Mock;
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  const clock = new Date('2026-11-07T10:00:00.000Z');
  const canModerate = (actor: unknown) =>
    actor === 'creator-1' || actor === 'moderator';
  const isAdmin = (actor: unknown) => actor === 'platform-admin';

  const answer = (sql: string, values: unknown[]): [unknown, unknown] => {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT posts.id, posts.author_id')) {
      return [
        post ? [{ ...post, can_moderate: canModerate(values[0]) ? 1 : 0 }] : [],
        [],
      ];
    }
    if (sql.startsWith('UPDATE posts SET removed_at')) {
      const removing = sql.includes('UTC_TIMESTAMP()');
      post = {
        ...post!,
        removed_at: removing ? clock : null,
        removed_by: removing ? (values[0] as string) : null,
        removal_reason: removing ? (values[1] as string | null) : null,
      };
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('SELECT id, title, content, type')) {
      return [
        post
          ? [
              {
                ...post,
                content: 'Body',
                type: 'text',
                created_at: new Date('2026-10-22T08:00:00.000Z'),
                pinned_at: null,
                pinned_by: null,
                edited_at: null,
                locked_at: null,
                locked_by: null,
              },
            ]
          : [],
        [],
      ];
    }
    if (sql.startsWith('SELECT target_id, SUM(value) AS score')) {
      return [[], []];
    }
    if (sql.startsWith('SELECT (')) {
      const [, creatorOrMod, , admin] = values;
      return [
        [{ can_review: canModerate(creatorOrMod) || isAdmin(admin) ? 1 : 0 }],
        [],
      ];
    }
    if (sql.startsWith('SELECT post_id FROM saved_posts')) {
      return [[], []];
    }
    // The ban lookup (CommunityBanPolicyService): no ban here.
    if (sql.includes('FROM community_bans')) {
      return [[], []];
    }
    // Closing the post's community reports (migration 036): none open.
    if (sql.startsWith('UPDATE user_reports')) {
      return [{ affectedRows: 0 }, []];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  beforeEach(async () => {
    queries = [];
    post = {
      id: 'post-1',
      author_id: 'author',
      community_id: 'community-1',
      title: 'Hello',
      removed_at: null,
      removed_by: null,
      removal_reason: null,
    };
    notifications = { record: jest.fn().mockResolvedValue(undefined) };
    log = { record: jest.fn().mockResolvedValue(undefined) };
    assertAccepted = jest.fn().mockResolvedValue(undefined);
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => Promise.resolve(answer(sql, values)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PostsService,
        {
          provide: MYSQL_POOL,
          useValue: {
            getConnection: () => Promise.resolve(connection),
            execute: (sql: string, values: unknown[]) =>
              Promise.resolve(answer(sql, values)),
          },
        },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: CommunityRuleAcceptanceService,
          useValue: { assertAcceptedOrThrow: assertAccepted },
        },
        { provide: CommunityModerationLogService, useValue: log },
      ],
    }).compile();
    service = module.get(PostsService);
  });

  const writes = () =>
    queries.filter(({ sql }) => sql.startsWith('UPDATE posts'));
  const expectCommittedAndReleased = () => {
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  };
  const expectRolledBackAndReleased = () => {
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  };

  describe('removeContent', () => {
    it.each(['moderator', 'creator-1'])(
      'lets %s remove: keeps the row, sets all three columns, notifies and logs once',
      async (actor) => {
        const result = await service.removeContent(
          'post-1',
          { reason: 'Spam' },
          actor,
        );

        expect(queries[0].sql).toContain('FOR UPDATE');
        expect(writes()).toEqual([
          {
            sql: 'UPDATE posts SET removed_at = UTC_TIMESTAMP(), removed_by = ?, removal_reason = ? WHERE id = ? AND removed_at IS NULL',
            values: [actor, 'Spam', 'post-1'],
          },
        ]);
        expect(
          queries.some(({ sql }) => sql.startsWith('DELETE FROM posts')),
        ).toBe(false);
        expect(result).toMatchObject({
          id: 'post-1',
          removed: true,
          removed_at: clock.toISOString(),
          removed_by: actor,
          removal_reason: 'Spam',
        });
        // #44: a null actor and the title snapshot only, never the reason
        // or the moderator.
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
        expect(JSON.stringify(notifications.record.mock.calls)).not.toMatch(
          /Spam|moderator|creator-1/,
        );
        expect(log.record).toHaveBeenCalledTimes(1);
        expect(log.record).toHaveBeenCalledWith(connection, {
          actorId: actor,
          communityId: 'community-1',
          action: 'post_removed',
          targetType: 'post',
          targetId: 'post-1',
          metadata: { reason: 'Spam' },
        });
        expect(assertAccepted).not.toHaveBeenCalled();
        expectCommittedAndReleased();
      },
    );

    it('stores a missing reason as NULL and logs no reason', async () => {
      await service.removeContent('post-1', {}, 'moderator');
      expect(writes()[0].values).toEqual(['moderator', null, 'post-1']);
      expect((log.record.mock.calls[0] as unknown[])[1]).not.toHaveProperty(
        'metadata',
      );
    });

    it.each([
      [
        'author',
        'Moderators remove posts; authors delete their own with DELETE /posts/:id',
      ],
      [
        'stranger',
        'Only the community creator and moderators can remove or restore posts',
      ],
    ])('refuses %s with 403', async (actor, message) => {
      await expect(service.removeContent('post-1', {}, actor)).rejects.toThrow(
        new ForbiddenException(message),
      );
      expect(writes()).toHaveLength(0);
      expect(notifications.record).not.toHaveBeenCalled();
      expectRolledBackAndReleased();
    });

    it('answers 404 for an unknown post and 409 for a removed one', async () => {
      post = undefined;
      await expect(
        service.removeContent('missing', {}, 'moderator'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expectRolledBackAndReleased();

      post = {
        id: 'post-1',
        author_id: 'author',
        community_id: 'community-1',
        title: 'Hello',
        removed_at: clock,
        removed_by: 'creator-1',
        removal_reason: null,
      };
      connection.rollback.mockClear();
      connection.release.mockClear();
      await expect(
        service.removeContent('post-1', {}, 'moderator'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(writes()).toHaveLength(0);
      expectRolledBackAndReleased();
    });

    it.each([
      ['the notification', () => notifications.record],
      ['the log entry', () => log.record],
    ])('rolls back when %s cannot be written', async (_label, writer) => {
      writer().mockRejectedValueOnce(new Error('write failed'));
      await expect(
        service.removeContent('post-1', {}, 'moderator'),
      ).rejects.toThrow('write failed');
      expectRolledBackAndReleased();
    });
  });

  describe('restore', () => {
    beforeEach(() => {
      post = {
        ...post!,
        removed_at: clock,
        removed_by: 'moderator',
        removal_reason: 'x',
      };
    });

    it('clears all three columns, logs post_restored and notifies nobody', async () => {
      const result = await service.restore('post-1', 'creator-1');
      expect(writes()).toEqual([
        {
          sql: 'UPDATE posts SET removed_at = NULL, removed_by = NULL, removal_reason = NULL WHERE id = ? AND removed_at IS NOT NULL',
          values: ['post-1'],
        },
      ]);
      expect(result).not.toHaveProperty('removed');
      expect(log.record).toHaveBeenCalledWith(connection, {
        actorId: 'creator-1',
        communityId: 'community-1',
        action: 'post_restored',
        targetType: 'post',
        targetId: 'post-1',
      });
      expect(notifications.record).not.toHaveBeenCalled();
      expectCommittedAndReleased();
    });

    it('answers 409 for a post that is not removed', async () => {
      post = {
        ...post!,
        removed_at: null,
        removed_by: null,
        removal_reason: null,
      };
      await expect(
        service.restore('post-1', 'moderator'),
      ).rejects.toBeInstanceOf(ConflictException);
      expectRolledBackAndReleased();
    });

    it('refuses the author with 403', async () => {
      await expect(service.restore('post-1', 'author')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expectRolledBackAndReleased();
    });

    it('rolls back when the log entry cannot be written', async () => {
      log.record.mockRejectedValueOnce(new Error('log failed'));
      await expect(service.restore('post-1', 'moderator')).rejects.toThrow(
        'log failed',
      );
      expectRolledBackAndReleased();
    });
  });

  describe('findOne visibility', () => {
    beforeEach(() => {
      post = {
        ...post!,
        removed_at: clock,
        removed_by: null,
        removal_reason: 'Spam',
      };
    });

    it.each([undefined, 'author', 'stranger'])(
      'answers 404 to %s',
      async (viewer) => {
        await expect(service.findOne('post-1', viewer)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      },
    );

    it.each(['moderator', 'creator-1', 'platform-admin'])(
      'shows %s the full post with its removal state, rendering a deleted moderator as null',
      async (viewer) => {
        await expect(service.findOne('post-1', viewer)).resolves.toMatchObject({
          id: 'post-1',
          title: 'Hello',
          content: 'Body',
          removed: true,
          removed_at: clock.toISOString(),
          removed_by: null,
          removal_reason: 'Spam',
        });
      },
    );

    it('asks the reviewer helper only for a removed post, without the removal fields otherwise', async () => {
      post = {
        ...post!,
        removed_at: null,
        removed_by: null,
        removal_reason: null,
      };
      const result = await service.findOne('post-1', 'moderator');
      expect(result).not.toHaveProperty('removed');
      expect(result).not.toHaveProperty('removal_reason');
      expect(queries.some(({ sql }) => sql.startsWith('SELECT ('))).toBe(false);
    });
  });
});
