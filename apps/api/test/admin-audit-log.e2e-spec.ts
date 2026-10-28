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
import type { PlatformRole } from '../src/users/users.service';

interface ActionFixture {
  id: string;
  actor_id: string | null;
  actor_username: string;
  action: string;
  target_type: 'user' | 'report' | 'restriction';
  target_id: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface AuditLogResponse {
  items: Array<{
    id: string;
    actor_username: string;
    actor_id: string | null;
    action: string;
    target_type: string;
    target_id: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;
  page: number;
  limit: number;
  total: number;
  filters: Record<string, unknown>;
}

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

// Keys that must never appear anywhere in an audit-log response.
const FORBIDDEN_KEYS = [
  'email',
  'password',
  'password_hash',
  'token',
  'token_hash',
  'session',
  'session_id',
  'reason',
  'lift_reason',
  'resolution_note',
  'description',
  'note',
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

describe('Admin audit log API (e2e)', () => {
  let app: INestApplication<App>;
  let actions: ActionFixture[];
  let roles: Map<string, PlatformRole>;
  let listQueries: Array<{ sql: string; values: unknown[] }>;

  beforeEach(async () => {
    roles = new Map([
      ['admin-id', 'admin'],
      ['moderator-id', 'moderator'],
      ['user-id', 'user'],
    ]);
    const sessions = new Map([
      [hashToken('admin-token'), 'admin-id'],
      [hashToken('moderator-token'), 'moderator-id'],
      [hashToken('user-token'), 'user-id'],
    ]);
    listQueries = [];

    // 25 entries one hour apart, plus a pair written in the same second.
    actions = Array.from({ length: 25 }, (_, index) => {
      const kind = index % 4;
      return {
        id: `action-${String(index + 1).padStart(2, '0')}`,
        actor_id: index < 5 ? null : 'admin-id',
        actor_username: index < 5 ? 'departed_admin' : 'admin',
        action: [
          'report_status_changed',
          'user_suspended',
          'user_banned',
          'restriction_lifted',
        ][kind],
        target_type: (['report', 'user', 'user', 'restriction'] as const)[kind],
        target_id:
          kind === 0
            ? `report-${index}`
            : kind === 3
              ? `restriction-${index}`
              : index === 2
                ? 'deleted-user'
                : 'target-id',
        metadata: [
          {
            from_status: 'open',
            to_status: 'resolved',
            resolution: 'user_banned',
          },
          {
            restriction_id: `restriction-${index}`,
            expires_at: '2026-02-01T00:00:00.000Z',
            report_id: null,
          },
          { restriction_id: `restriction-${index}`, report_id: 'report-0' },
          { restriction_id: `restriction-${index}`, restriction_type: 'ban' },
        ][kind],
        created_at: new Date(Date.UTC(2026, 0, 1, index)),
      };
    });
    actions.push(
      {
        id: 'same-second-a',
        actor_id: 'admin-id',
        actor_username: 'admin',
        action: 'report_status_changed',
        target_type: 'report',
        target_id: 'report-pair',
        metadata: {
          from_status: 'open',
          to_status: 'resolved',
          resolution: 'user_banned',
        },
        created_at: new Date(Date.UTC(2026, 0, 3, 0, 0, 0)),
      },
      {
        id: 'same-second-b',
        actor_id: 'admin-id',
        actor_username: 'admin',
        action: 'user_banned',
        target_type: 'user',
        target_id: 'target-id',
        metadata: null,
        created_at: new Date(Date.UTC(2026, 0, 3, 0, 0, 0)),
      },
    );

    const matching = (sql: string, values: unknown[]) => {
      const where = sql.includes(' WHERE ')
        ? sql.slice(
            sql.indexOf(' WHERE '),
            sql.includes(' ORDER BY') ? sql.indexOf(' ORDER BY') : sql.length,
          )
        : '';
      let parameter = 0;
      let result = actions;
      const sqlDate = (value: unknown) =>
        new Date(`${String(value).replace(' ', 'T')}Z`).getTime();
      const conditions: Array<
        [string, (row: ActionFixture, value: unknown) => boolean]
      > = [
        ['actor_username = ?', (row, value) => row.actor_username === value],
        ['action = ?', (row, value) => row.action === value],
        ['target_type = ?', (row, value) => row.target_type === value],
        ['target_id = ?', (row, value) => row.target_id === value],
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
      if (sql === 'SELECT role FROM users WHERE id = ? LIMIT 1') {
        const role = roles.get(String(values[0]));
        return result(role ? [{ role }] : []);
      }
      if (sql.startsWith('SELECT id, actor_id, actor_username')) {
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
        return result(rows.slice(offset, offset + limit));
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM admin_actions')) {
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

  const get = (path: string, token = 'admin-token') =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`);
  const list = async (path: string) =>
    (await get(path).expect(200)).body as AuditLogResponse;

  it('enforces authentication and administrator-only access', async () => {
    const unauthenticated = await request(app.getHttpServer())
      .get('/admin/audit-log')
      .expect(401);
    const member = await get('/admin/audit-log', 'user-token').expect(403);
    const moderator = await get('/admin/audit-log', 'moderator-token').expect(
      403,
    );
    for (const response of [unauthenticated, member, moderator]) {
      expect(JSON.stringify(response.body)).not.toContain('action-');
      expect(response.body).not.toHaveProperty('items');
    }
    expect(listQueries).toHaveLength(0);
  });

  it('returns the documented envelope, item fields and stored metadata', async () => {
    const body = await list('/admin/audit-log');

    expect(Object.keys(body).sort()).toEqual(
      ['filters', 'items', 'limit', 'page', 'total'].sort(),
    );
    expect(body).toMatchObject({ page: 1, limit: 20, total: 27 });
    expect(body.filters).toEqual({
      actor_username: null,
      action: null,
      target_type: null,
      target_id: null,
      from: null,
      to: null,
      sort: 'new',
    });
    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        'action',
        'actor_id',
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
      id: 'action-25',
      actor_username: 'admin',
      actor_id: 'admin-id',
      action: 'report_status_changed',
      target_type: 'report',
      target_id: 'report-24',
      metadata: {
        from_status: 'open',
        to_status: 'resolved',
        resolution: 'user_banned',
      },
      created_at: '2026-01-02T00:00:00.000Z',
    });
  });

  it.each(['new', 'oldest'])(
    'pages through a total %s ordering including same-second entries',
    async (sort) => {
      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const body = await list(
          `/admin/audit-log?sort=${sort}&limit=10&page=${page}`,
        );
        expect(body.total).toBe(27);
        seen.push(...body.items.map((item) => item.id));
      }
      expect(seen).toHaveLength(27);
      expect(new Set(seen).size).toBe(27);

      const pair = ['same-second-a', 'same-second-b'];
      const positions = pair.map((id) => seen.indexOf(id));
      expect(Math.abs(positions[0] - positions[1])).toBe(1);
      expect(seen[Math.min(...positions)]).toBe(
        sort === 'new' ? 'same-second-b' : 'same-second-a',
      );
      expect(seen[0]).toBe(sort === 'new' ? 'same-second-b' : 'action-01');
    },
  );

  it('narrows items and total for each filter', async () => {
    const cases: Array<
      [string, (item: AuditLogResponse['items'][0]) => boolean, number]
    > = [
      ['actor_username=admin', (item) => item.actor_username === 'admin', 22],
      ['action=user_banned', (item) => item.action === 'user_banned', 7],
      [
        'target_type=restriction',
        (item) => item.target_type === 'restriction',
        6,
      ],
      [
        'target_type=user&target_id=target-id',
        (item) => item.target_type === 'user' && item.target_id === 'target-id',
        12,
      ],
    ];

    for (const [filter, predicate, expected] of cases) {
      const body = await list(`/admin/audit-log?${filter}&limit=100`);
      expect(body.total).toBe(expected);
      expect(body.items).toHaveLength(expected);
      expect(body.items.every(predicate)).toBe(true);
    }

    const combined = await list(
      '/admin/audit-log?actor_username=admin&action=user_banned&limit=2',
    );
    expect(combined.total).toBe(6);
    expect(combined.items).toHaveLength(2);
    expect(combined.filters).toMatchObject({
      actor_username: 'admin',
      action: 'user_banned',
    });
  });

  it('finds entries by deleted actors through the username snapshot', async () => {
    const body = await list('/admin/audit-log?actor_username=departed_admin');

    expect(body.total).toBe(5);
    expect(body.items.every((item) => item.actor_id === null)).toBe(true);
    expect(
      body.items.every((item) => item.actor_username === 'departed_admin'),
    ).toBe(true);
  });

  it('returns entries whose target no longer exists', async () => {
    const body = await list(
      '/admin/audit-log?target_type=user&target_id=deleted-user',
    );

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 'action-03',
      target_id: 'deleted-user',
    });
  });

  it('filters by a half-open UTC interval', async () => {
    const body = await list(
      '/admin/audit-log?from=2026-01-01T02:00:00Z&to=2026-01-01T05:00:00Z',
    );

    expect(body.items.map((item) => item.id).sort()).toEqual([
      'action-03',
      'action-04',
      'action-05',
    ]);
    expect(body.total).toBe(3);

    const offset = await list(
      '/admin/audit-log?from=2026-01-01T03:00:00%2B01:00&to=2026-01-01T05:00:00%2B01:00',
    );
    expect(offset.items.map((item) => item.id).sort()).toEqual([
      'action-03',
      'action-04',
    ]);
  });

  it.each([
    'target_id=target-id',
    'action=user_deleted',
    'target_type=post',
    'actor_username=ab',
    'from=yesterday',
    'to=2026-13-01',
    'page=0',
    'page=10001',
    'limit=0',
    'limit=101',
    'sort=random',
    'actor_id=admin-id',
    'unknown=1',
  ])('rejects %s with 400', async (query) => {
    await get(`/admin/audit-log?${query}`).expect(400);
    expect(listQueries).toHaveLength(0);
  });

  it.each(['patch', 'put', 'delete'] as const)(
    'exposes no %s route on the audit log',
    async (method) => {
      for (const path of ['/admin/audit-log', '/admin/audit-log/action-01']) {
        await request(app.getHttpServer())
          [method](path)
          .set('Authorization', 'Bearer admin-token')
          .send({ action: 'user_banned' })
          .expect(404);
      }
    },
  );

  it('never returns personal data, credentials or free-text notes', async () => {
    const bodies: unknown[] = [];
    for (const page of [1, 2]) {
      bodies.push(await list(`/admin/audit-log?limit=100&page=${page}`));
    }
    bodies.push(await list('/admin/audit-log?actor_username=departed_admin'));

    for (const body of bodies) {
      const keys = collectKeys(body);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys).not.toContain(forbidden);
      }
      const serialised = JSON.stringify(body);
      expect(serialised).not.toMatch(/@|\$argon2|password/i);
    }
    const metadataKeys = new Set(
      (bodies[0] as AuditLogResponse).items.flatMap((item) =>
        Object.keys(item.metadata ?? {}),
      ),
    );
    expect([...metadataKeys].sort()).toEqual(
      [
        'expires_at',
        'from_status',
        'report_id',
        'resolution',
        'restriction_id',
        'restriction_type',
        'to_status',
      ].sort(),
    );
  });
});
