import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { ApiRateLimitInterceptor } from '../src/common/api-rate-limit.interceptor';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';

interface NotificationFixture {
  id: string;
  recipient_id: string;
  type: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string;
  community_id: string | null;
  metadata: Record<string, string> | null;
  read_at: Date | null;
  created_at: Date;
}

interface NotificationItem {
  id: string;
  type: string;
  actor_username: string | null;
  read_at: string | null;
  metadata: Record<string, string> | null;
}

interface NotificationPage {
  items: NotificationItem[];
  page: number;
  limit: number;
  total: number;
}

const tokens: Record<
  string,
  | { kind: 'valid'; userId: string }
  | {
      kind: 'restricted';
      userId: string;
      restriction: { type: 'suspension' | 'ban'; expires_at: string | null };
    }
> = {
  'token-a': { kind: 'valid', userId: 'user-a' },
  'token-b': { kind: 'valid', userId: 'user-b' },
  'token-empty': { kind: 'valid', userId: 'user-empty' },
  'token-suspended': {
    kind: 'restricted',
    userId: 'user-suspended',
    restriction: {
      type: 'suspension',
      expires_at: '2026-11-01T00:00:00.000Z',
    },
  },
  'token-banned': {
    kind: 'restricted',
    userId: 'user-banned',
    restriction: { type: 'ban', expires_at: null },
  },
};

// Extra columns that a careless SELECT * or join would leak.
const privateColumns = {
  email: 'private@example.com',
  password_hash: 'private-hash',
  refresh_token: 'private-token',
  session_id: 'private-session',
};

const at = (minute: number) => new Date(Date.UTC(2026, 9, 22, 8, minute, 0));

describe('Notification inbox endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let notifications: NotificationFixture[];
  let queries: Array<{ sql: string; values: unknown[] }>;
  let rateLimitCalls: Array<{ method: string; path: string }>;

  const server = () => app.getHttpServer();
  const get = (path: string, token?: string) => {
    const pending = request(server()).get(path);
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  };
  const ids = (body: unknown) =>
    (body as NotificationPage).items.map((item) => item.id);

  beforeEach(async () => {
    queries = [];
    rateLimitCalls = [];
    // 12 rows for user A sharing timestamps in pairs, so ordering relies on
    // the id tiebreaker; every third one is read.
    notifications = Array.from({ length: 12 }, (_, index) => ({
      id: `a-${String(index).padStart(2, '0')}`,
      recipient_id: 'user-a',
      type: index % 2 === 0 ? 'post_comment' : 'community_post',
      actor_id: `actor-${index}`,
      subject_type: index % 2 === 0 ? 'comment' : 'post',
      subject_id: `subject-${index}`,
      community_id: index < 6 ? 'community-1' : 'community-2',
      metadata: {
        actor_username: `actor_${index}`,
        community_name: index < 6 ? 'gardening' : 'cooking',
        post_title: `Post ${index}`,
      },
      read_at: index % 3 === 0 ? at(59) : null,
      created_at: at(Math.floor(index / 2)),
    }));
    notifications.push(
      {
        id: 'b-secret',
        recipient_id: 'user-b',
        type: 'comment_reply',
        actor_id: 'user-a',
        subject_type: 'comment',
        subject_id: 'comment-b',
        community_id: 'community-1',
        metadata: { actor_username: 'user_a', excerpt: 'B only' },
        read_at: null,
        created_at: at(30),
      },
      {
        id: 'a-deleted-subject',
        recipient_id: 'user-a',
        type: 'content_removed',
        actor_id: null,
        subject_type: 'comment',
        subject_id: 'comment-that-no-longer-exists',
        community_id: 'community-1',
        metadata: {
          community_name: 'gardening',
          post_title: 'Gone',
          excerpt: 'Removed text',
        },
        read_at: null,
        created_at: at(40),
      },
      {
        id: 'a-deleted-actor',
        recipient_id: 'user-a',
        type: 'comment_reply',
        actor_id: null,
        subject_type: 'comment',
        subject_id: 'comment-x',
        community_id: 'community-1',
        metadata: {
          actor_username: 'former_user',
          post_id: 'post-1',
          parent_comment_id: 'comment-0',
          excerpt: 'Hi',
        },
        read_at: null,
        created_at: at(41),
      },
      {
        id: 'suspended-notice',
        recipient_id: 'user-suspended',
        type: 'restriction_applied',
        actor_id: null,
        subject_type: 'restriction',
        subject_id: 'restriction-1',
        community_id: null,
        metadata: {
          restriction_type: 'suspension',
          expires_at: '2026-11-01T00:00:00.000Z',
        },
        read_at: null,
        created_at: at(50),
      },
    );

    // Applies exactly the conditions the service sends, in bound order.
    const matching = (where: string, values: unknown[]) => {
      const conditions = where.split(' AND ');
      return notifications.filter((row) => {
        let parameter = 0;
        return conditions.every((condition) => {
          switch (condition) {
            case 'recipient_id = ?':
              return row.recipient_id === values[parameter++];
            case 'id = ?':
              return row.id === values[parameter++];
            case 'type = ?':
              return row.type === values[parameter++];
            case 'community_id = ?':
              return row.community_id === values[parameter++];
            case 'read_at IS NULL':
              return row.read_at === null;
            case 'read_at IS NOT NULL':
              return row.read_at !== null;
            default:
              throw new Error(`Unexpected condition: ${condition}`);
          }
        });
      });
    };
    const execute = (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      if (/\bJOIN\b|UPDATE|INSERT|DELETE/i.test(sql)) {
        throw new Error(`Unexpected statement: ${sql}`);
      }

      const listing =
        /^SELECT (.+) FROM notifications WHERE (.+?) ORDER BY created_at (ASC|DESC), id (ASC|DESC) LIMIT \? OFFSET \?$/.exec(
          sql,
        );
      if (listing) {
        const direction = listing[3] === 'ASC' ? 1 : -1;
        const limit = values[values.length - 2] as number;
        const offset = values[values.length - 1] as number;
        const rows = matching(listing[2], values.slice(0, -2))
          .sort(
            (left, right) =>
              direction *
              (left.created_at.getTime() - right.created_at.getTime() ||
                left.id.localeCompare(right.id)),
          )
          .slice(offset, offset + limit)
          .map((row) => ({ ...row, ...privateColumns }));
        return Promise.resolve([rows, []]);
      }

      const count =
        /^SELECT COUNT\(\*\) AS (total|unread) FROM notifications WHERE (.+)$/.exec(
          sql,
        );
      if (count) {
        return Promise.resolve([
          [{ [count[1]]: matching(count[2], values).length }],
          [],
        ]);
      }

      const detail =
        /^SELECT .+ FROM notifications WHERE (id = \? AND recipient_id = \?) LIMIT 1$/.exec(
          sql,
        );
      if (detail) {
        return Promise.resolve([
          matching(detail[1], values).map((row) => ({
            ...row,
            ...privateColumns,
          })),
          [],
        ]);
      }

      throw new Error(`Unexpected SQL query: ${sql}`);
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({ execute })
      .overrideProvider(AuthRateLimitService)
      .useValue({
        enforceApiRequest: (_ip: string, method: string, path: string) => {
          rateLimitCalls.push({ method, path });
          return Promise.resolve(null);
        },
      })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) =>
          Promise.resolve(tokens[token] ?? { kind: 'invalid' }),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
    app.useGlobalInterceptors(
      new ApiRateLimitInterceptor(app.get(AuthRateLimitService)),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    '/notifications',
    '/notifications/unread-count',
    '/notifications/a-00',
  ])('returns 401 without a valid token for %s', async (path) => {
    await get(path).expect(401);
    await get(path, 'invalid-token').expect(401);
    expect(queries).toHaveLength(0);
  });

  it('lists only the caller rows and binds the token user', async () => {
    const response = await get('/notifications?limit=100', 'token-a').expect(
      200,
    );
    const body = response.body as NotificationPage;

    expect(body).toMatchObject({ page: 1, limit: 100, total: 14 });
    expect(ids(body)).not.toContain('b-secret');
    expect(ids(body)).not.toContain('suspended-notice');
    expect(queries.every((query) => query.values[0] === 'user-a')).toBe(true);

    const other = await get('/notifications', 'token-b').expect(200);
    expect(ids(other.body)).toEqual(['b-secret']);
  });

  it('rejects every attempt to choose the recipient', async () => {
    for (const parameter of ['recipient_id', 'user_id', 'recipient']) {
      await get(`/notifications?${parameter}=user-b`, 'token-a').expect(400);
    }
  });

  it('pages in a stable order, returning each row exactly once', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const response = await get(
        `/notifications?limit=4&page=${page}`,
        'token-a',
      ).expect(200);
      seen.push(...ids(response.body));
    }

    expect(seen).toHaveLength(14);
    expect(new Set(seen).size).toBe(14);
    expect(seen.slice(0, 4)).toEqual([
      'a-deleted-actor',
      'a-deleted-subject',
      'a-11',
      'a-10',
    ]);

    const oldest = await get(
      '/notifications?sort=oldest&limit=100',
      'token-a',
    ).expect(200);
    expect(ids(oldest.body)).toEqual([...seen].reverse());
  });

  it('filters by read state, type and community', async () => {
    const unread = await get(
      '/notifications?read=false&limit=100',
      'token-a',
    ).expect(200);
    const read = await get(
      '/notifications?read=true&limit=100',
      'token-a',
    ).expect(200);
    const items = (body: unknown) => (body as NotificationPage).items;

    expect(items(unread.body).every((item) => item.read_at === null)).toBe(
      true,
    );
    expect(items(read.body).every((item) => item.read_at !== null)).toBe(true);
    expect(
      (unread.body as NotificationPage).total +
        (read.body as NotificationPage).total,
    ).toBe(14);

    const typed = await get(
      '/notifications?type=content_removed',
      'token-a',
    ).expect(200);
    expect(ids(typed.body)).toEqual(['a-deleted-subject']);

    const community = await get(
      '/notifications?community_id=community-2&limit=100',
      'token-a',
    ).expect(200);
    expect(ids(community.body)).toEqual([
      'a-11',
      'a-10',
      'a-09',
      'a-08',
      'a-07',
      'a-06',
    ]);
  });

  it.each([
    'read=maybe',
    'type=vote',
    'community_id=bad%20id',
    `community_id=${'a'.repeat(37)}`,
    'page=0',
    'page=10001',
    'page=1.5',
    'limit=0',
    'limit=101',
    'sort=random',
    'unexpected=1',
  ])('rejects query %s with 400', async (query) => {
    await get(`/notifications?${query}`, 'token-a').expect(400);
  });

  it('returns an empty envelope and a zero count for an empty inbox', async () => {
    await get('/notifications', 'token-empty').expect(200, {
      items: [],
      page: 1,
      limit: 20,
      total: 0,
    });
    await get('/notifications/unread-count', 'token-empty').expect(200, {
      unread: 0,
    });
  });

  it('counts only the caller unread rows on the unread-count route', async () => {
    const expected = notifications.filter(
      (row) => row.recipient_id === 'user-a' && row.read_at === null,
    ).length;

    await get('/notifications/unread-count', 'token-a').expect(200, {
      unread: expected,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('AS unread');
  });

  it('returns a single notification without changing read_at', async () => {
    const before = structuredClone(notifications);

    const response = await get('/notifications/a-01', 'token-a').expect(200);

    expect(response.body).toEqual({
      id: 'a-01',
      type: 'community_post',
      actor_username: 'actor_1',
      subject_type: 'post',
      subject_id: 'subject-1',
      community_id: 'community-1',
      community_name: 'gardening',
      metadata: { post_title: 'Post 1' },
      read_at: null,
      created_at: '2026-10-22T08:00:00.000Z',
    });
    expect(notifications).toEqual(before);
    expect(queries.every((query) => query.sql.startsWith('SELECT'))).toBe(true);
  });

  it('answers 404, not 403, for another user notification or an unknown id', async () => {
    await get('/notifications/b-secret', 'token-a').expect(404);
    await get('/notifications/does-not-exist', 'token-a').expect(404);
    await get('/notifications/b-secret', 'token-b').expect(200);
    await get('/notifications/bad%20id', 'token-a').expect(400);
  });

  it('renders rows whose subject or actor no longer exists', async () => {
    const removed = await get(
      '/notifications/a-deleted-subject',
      'token-a',
    ).expect(200);
    expect(removed.body).toMatchObject({
      type: 'content_removed',
      actor_username: null,
      subject_id: 'comment-that-no-longer-exists',
      community_name: 'gardening',
      metadata: { post_title: 'Gone', excerpt: 'Removed text' },
    });

    const orphaned = await get(
      '/notifications/a-deleted-actor',
      'token-a',
    ).expect(200);
    expect(orphaned.body).toMatchObject({
      actor_username: 'former_user',
      metadata: {
        post_id: 'post-1',
        parent_comment_id: 'comment-0',
        excerpt: 'Hi',
      },
    });
  });

  it('lets suspended and banned accounts read their inbox', async () => {
    const list = await get('/notifications', 'token-suspended').expect(200);
    expect((list.body as NotificationPage).items).toEqual([
      expect.objectContaining({
        id: 'suspended-notice',
        type: 'restriction_applied',
        actor_username: null,
        metadata: {
          restriction_type: 'suspension',
          expires_at: '2026-11-01T00:00:00.000Z',
        },
      }),
    ]);
    await get('/notifications/unread-count', 'token-suspended').expect(200, {
      unread: 1,
    });
    await get('/notifications/suspended-notice', 'token-suspended').expect(200);
    await get('/notifications', 'token-banned').expect(200);
    await get('/notifications/suspended-notice', 'token-banned').expect(404);
  });

  it('never returns private fields or a moderator identity', async () => {
    const responses = [
      await get('/notifications?limit=100', 'token-a'),
      await get('/notifications/unread-count', 'token-a'),
      await get('/notifications/a-deleted-subject', 'token-a'),
      await get('/notifications', 'token-suspended'),
    ];

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.text).not.toMatch(
        /email|password|private-|session|refresh_token|actor_id/i,
      );
    }
    const removed = responses[2].body as NotificationItem;
    expect(removed.actor_username).toBeNull();
  });

  it('keeps every route behind the global rate limiter', async () => {
    await get('/notifications', 'token-a');
    await get('/notifications/unread-count', 'token-a');
    await get('/notifications/a-00', 'token-a');

    expect(rateLimitCalls).toEqual([
      { method: 'GET', path: '/notifications' },
      { method: 'GET', path: '/notifications/unread-count' },
      { method: 'GET', path: '/notifications/a-00' },
    ]);
  });
});
