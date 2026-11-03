import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import { createHash } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { MYSQL_POOL } from '../src/auth/auth.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';

interface EntryFixture {
  id: string;
  community_id: string;
  actor_id: string | null;
  actor_username: string;
  action: string;
  target_type: 'post' | 'comment' | 'user' | 'rule_document';
  target_id: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface ModerationLogResponse {
  items: Array<{
    id: string;
    action: string;
    actor_username: string;
    target_type: string;
    target_id: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;
  page: number;
  limit: number;
  total: number;
}

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

// Keys that must never appear anywhere in a moderation-log response.
const FORBIDDEN_KEYS = [
  'email',
  'password',
  'password_hash',
  'token',
  'token_hash',
  'session',
  'session_id',
  'actor_id',
  'community_id',
  'body',
  'content',
  'title',
];

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, keys));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

const ACTIONS: Array<
  [string, EntryFixture['target_type'], Record<string, unknown> | null]
> = [
  ['post_removed', 'post', { reason: 'Spam' }],
  ['comment_locked', 'comment', null],
  ['member_banned', 'user', { username: 'member', reason: 'Abuse' }],
  ['rules_published', 'rule_document', { version: 2 }],
];

describe('Community moderation log API (e2e)', () => {
  let app: INestApplication<App>;
  let entries: EntryFixture[];
  let listQueries: Array<{ sql: string; values: unknown[] }>;

  beforeEach(async () => {
    // users: id -> username, email and password hash; the hash and email
    // must never reach a response.
    const sessions = new Map([
      [hashToken('creator-token'), 'creator-id'],
      [hashToken('moderator-token'), 'moderator-id'],
      [hashToken('member-token'), 'member-id'],
      [hashToken('admin-token'), 'admin-id'],
    ]);
    const communities = new Map([
      ['gardening', { id: 'community-1', creator_id: 'creator-id' }],
      ['empty', { id: 'community-2', creator_id: 'creator-id' }],
    ]);
    const moderators = new Set(['community-1:moderator-id']);
    listQueries = [];

    // 25 entries one hour apart, five of them by a deleted moderator, plus a
    // pair written in the same second and one entry in another community.
    entries = Array.from({ length: 25 }, (_, index) => {
      const [action, target_type, metadata] = ACTIONS[index % 4];
      return {
        id: `entry-${String(index + 1).padStart(2, '0')}`,
        community_id: 'community-1',
        actor_id: index < 5 ? null : 'moderator-id',
        actor_username: index < 5 ? 'departed_mod' : 'moderator',
        action,
        target_type,
        target_id: index === 0 ? 'hard-deleted-post' : `target-${index}`,
        metadata,
        created_at: new Date(Date.UTC(2026, 0, 1, index)),
      };
    });
    entries.push(
      {
        id: 'same-second-a',
        community_id: 'community-1',
        actor_id: 'creator-id',
        actor_username: 'creator',
        action: 'moderator_added',
        target_type: 'user',
        target_id: 'moderator-id',
        metadata: { username: 'moderator' },
        created_at: new Date(Date.UTC(2026, 0, 3)),
      },
      {
        id: 'same-second-b',
        community_id: 'community-1',
        actor_id: 'creator-id',
        actor_username: 'creator',
        action: 'post_pinned',
        target_type: 'post',
        target_id: 'target-pinned',
        metadata: null,
        created_at: new Date(Date.UTC(2026, 0, 3)),
      },
      {
        id: 'elsewhere',
        community_id: 'community-other',
        actor_id: 'moderator-id',
        actor_username: 'moderator',
        action: 'post_removed',
        target_type: 'post',
        target_id: 'other-post',
        metadata: null,
        created_at: new Date(Date.UTC(2026, 0, 2)),
      },
    );

    const matching = (sql: string, values: unknown[]) => {
      const where = sql.slice(
        sql.indexOf(' WHERE '),
        sql.includes(' ORDER BY') ? sql.indexOf(' ORDER BY') : sql.length,
      );
      let parameter = 0;
      let result = entries;
      const sqlDate = (value: unknown) =>
        new Date(`${String(value).replace(' ', 'T')}Z`).getTime();
      const conditions: Array<
        [string, (row: EntryFixture, value: unknown) => boolean]
      > = [
        ['community_id = ?', (row, value) => row.community_id === value],
        ['actor_username = ?', (row, value) => row.actor_username === value],
        ['action = ?', (row, value) => row.action === value],
        ['target_type = ?', (row, value) => row.target_type === value],
        [
          "created_at >= CONVERT_TZ(?, '+00:00', @@session.time_zone)",
          (row, value) => row.created_at.getTime() >= sqlDate(value),
        ],
        [
          "created_at < CONVERT_TZ(?, '+00:00', @@session.time_zone)",
          (row, value) => row.created_at.getTime() < sqlDate(value),
        ],
      ];
      for (const [condition, matches] of conditions) {
        if (where.includes(condition)) {
          const value = values[parameter++];
          result = result.filter((row) => matches(row, value));
        }
      }
      return result;
    };

    const result = (value: unknown) =>
      Promise.resolve([value, []] as [unknown, unknown]);
    const execute = (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT auth_sessions.user_id AS id')) {
        const userId = sessions.get(String(values[0]));
        return result(
          userId
            ? [
                {
                  id: userId,
                  restriction_type: null,
                  restriction_expires_at: null,
                },
              ]
            : [],
        );
      }
      if (sql.includes('SET last_seen_at = UTC_TIMESTAMP()')) {
        return result({ affectedRows: 1 });
      }
      if (
        sql.includes('AS can_moderate') &&
        sql.includes('FROM communities c')
      ) {
        const [userId, , name] = values.map(String);
        const community = communities.get(name);
        return result(
          community
            ? [
                {
                  id: community.id,
                  can_moderate:
                    community.creator_id === userId ||
                    moderators.has(`${community.id}:${userId}`)
                      ? 1
                      : 0,
                },
              ]
            : [],
        );
      }
      if (sql.startsWith('SELECT id, action, actor_username')) {
        listQueries.push({ sql, values });
        const direction = sql.includes('created_at ASC') ? 1 : -1;
        const rows = [...matching(sql, values)].sort(
          (left, right) =>
            direction *
            (left.created_at.getTime() - right.created_at.getTime() ||
              left.id.localeCompare(right.id)),
        );
        const limit = Number(values[values.length - 2]);
        const offset = Number(values[values.length - 1]);
        // Rows carry only the selected columns, as MySQL would return them.
        return result(
          rows.slice(offset, offset + limit).map((row) => ({
            id: row.id,
            action: row.action,
            actor_username: row.actor_username,
            target_type: row.target_type,
            target_id: row.target_id,
            metadata: row.metadata,
            created_at: row.created_at,
          })),
        );
      }
      if (
        sql.startsWith(
          'SELECT COUNT(*) AS total FROM community_moderation_actions',
        )
      ) {
        return result([{ total: matching(sql, values).length }]);
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({ execute })
      .compile();

    app = moduleFixture.createNestApplication({ logger: false });
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
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

  const LOG = '/communities/gardening/moderation-log';
  const get = (path: string, token = 'creator-token') =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`);
  const list = async (path: string, token?: string) =>
    (await get(path, token).expect(200)).body as ModerationLogResponse;

  it.each(['creator-token', 'moderator-token'])(
    'returns the envelope to %s',
    async (token) => {
      const body = await list(LOG, token);
      expect(Object.keys(body).sort()).toEqual(
        ['items', 'limit', 'page', 'total'].sort(),
      );
      expect(body).toMatchObject({ page: 1, limit: 20, total: 27 });
      expect(body.items).toHaveLength(20);
    },
  );

  it('refuses members, platform administrators and anonymous callers', async () => {
    const anonymous = await request(app.getHttpServer()).get(LOG).expect(401);
    const member = await get(LOG, 'member-token').expect(403);
    const admin = await get(LOG, 'admin-token').expect(403);
    for (const response of [anonymous, member, admin]) {
      expect(JSON.stringify(response.body)).not.toContain('entry-');
      expect(response.body).not.toHaveProperty('items');
    }
    expect(listQueries).toHaveLength(0);
  });

  it('answers 404 for an unknown community before any authorization refusal', async () => {
    for (const token of ['creator-token', 'member-token', 'admin-token']) {
      await get('/communities/missing/moderation-log', token).expect(404);
    }
    expect(listQueries).toHaveLength(0);
  });

  it.each(['bad.name', 'x'.repeat(51), 'na%20me'])(
    'answers 400 for the community name %s',
    async (name) => {
      await get(`/communities/${name}/moderation-log`).expect(400);
      expect(listQueries).toHaveLength(0);
    },
  );

  it('returns the documented item fields, newest first', async () => {
    const body = await list(LOG);

    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        'action',
        'actor_username',
        'created_at',
        'id',
        'metadata',
        'target_id',
        'target_type',
      ].sort(),
    );
    expect(body.items.slice(0, 2).map((item) => item.id)).toEqual([
      'same-second-b',
      'same-second-a',
    ]);
    expect(body.items[2]).toEqual({
      id: 'entry-25',
      action: 'post_removed',
      actor_username: 'moderator',
      target_type: 'post',
      target_id: 'target-24',
      metadata: { reason: 'Spam' },
      created_at: '2026-01-02T00:00:00.000Z',
    });
    expect(body.items.map((item) => item.id)).not.toContain('elsewhere');
  });

  it('returns 200 with no items for a community without entries', async () => {
    const body = await list('/communities/empty/moderation-log');
    expect(body).toEqual({ items: [], page: 1, limit: 20, total: 0 });
  });

  it.each(['new', 'oldest'])(
    'pages through a total %s ordering including same-second entries',
    async (sort) => {
      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const body = await list(`${LOG}?sort=${sort}&limit=10&page=${page}`);
        expect(body.total).toBe(27);
        seen.push(...body.items.map((item) => item.id));
      }
      expect(seen).toHaveLength(27);
      expect(new Set(seen).size).toBe(27);

      const positions = ['same-second-a', 'same-second-b'].map((id) =>
        seen.indexOf(id),
      );
      expect(Math.abs(positions[0] - positions[1])).toBe(1);
      expect(seen[Math.min(...positions)]).toBe(
        sort === 'new' ? 'same-second-b' : 'same-second-a',
      );
      expect(seen[0]).toBe(sort === 'new' ? 'same-second-b' : 'entry-01');
    },
  );

  it('narrows items and total for each filter', async () => {
    const cases: Array<
      [string, (item: ModerationLogResponse['items'][0]) => boolean, number]
    > = [
      [
        'actor_username=moderator',
        (item) => item.actor_username === 'moderator',
        20,
      ],
      ['action=member_banned', (item) => item.action === 'member_banned', 6],
      ['target_type=post', (item) => item.target_type === 'post', 8],
      [
        'from=2026-01-01T02:00:00Z&to=2026-01-01T05:00:00Z',
        (item) => ['entry-03', 'entry-04', 'entry-05'].includes(item.id),
        3,
      ],
    ];

    for (const [filter, predicate, expected] of cases) {
      const body = await list(`${LOG}?${filter}&limit=100`);
      expect(body.total).toBe(expected);
      expect(body.items).toHaveLength(expected);
      expect(body.items.every(predicate)).toBe(true);
    }
  });

  it('lists entries by a deleted moderator through the username snapshot', async () => {
    const body = await list(`${LOG}?actor_username=departed_mod`);

    expect(body.total).toBe(5);
    expect(
      body.items.every((item) => item.actor_username === 'departed_mod'),
    ).toBe(true);
  });

  it('lists entries whose target no longer exists', async () => {
    const body = await list(`${LOG}?sort=oldest&limit=1`);
    expect(body.items[0]).toMatchObject({
      id: 'entry-01',
      target_id: 'hard-deleted-post',
    });
  });

  it.each([
    'action=user_banned',
    'target_type=report',
    'actor_username=ab',
    'actor_username=bad-name',
    'from=yesterday',
    'to=2026-13-01',
    'page=0',
    'page=10001',
    'limit=0',
    'limit=101',
    'sort=random',
    'target_id=post-1',
    'actor_id=moderator-id',
    'unknown=1',
  ])('rejects %s with 400', async (query) => {
    await get(`${LOG}?${query}`).expect(400);
    expect(listQueries).toHaveLength(0);
  });

  it.each(['post', 'patch', 'put', 'delete'] as const)(
    'exposes no %s route on the moderation log',
    async (method) => {
      for (const path of [LOG, `${LOG}/entry-01`]) {
        await request(app.getHttpServer())
          [method](path)
          .set('Authorization', 'Bearer creator-token')
          .send({ action: 'post_removed' })
          .expect(404);
      }
    },
  );

  it('never returns personal data, credentials or content bodies', async () => {
    const bodies: unknown[] = [
      await list(`${LOG}?limit=100`),
      await list(`${LOG}?actor_username=departed_mod`, 'moderator-token'),
    ];

    for (const body of bodies) {
      const keys = collectKeys(body);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys).not.toContain(forbidden);
      }
      expect(JSON.stringify(body)).not.toMatch(/@|\$argon2|password/i);
    }
    const metadataKeys = new Set(
      (bodies[0] as ModerationLogResponse).items.flatMap((item) =>
        Object.keys(item.metadata ?? {}),
      ),
    );
    expect([...metadataKeys].sort()).toEqual(
      ['reason', 'username', 'version'].sort(),
    );
  });
});
