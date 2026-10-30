import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpAdapterHost } from '@nestjs/core';
import { argon2id, hash } from 'argon2';
import { createHash } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { MYSQL_POOL } from '../src/auth/auth.service';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import type { PlatformRole } from '../src/users/users.service';

interface UserFixture {
  username: string;
  email: string;
  role: PlatformRole;
}

interface RestrictionFixture {
  id: string;
  user_id: string;
  type: 'suspension' | 'ban';
  reason: string;
  created_by: string | null;
  created_at: Date;
  expires_at: Date | null;
  lifted_at: Date | null;
  lifted_by: string | null;
  lift_reason: string | null;
  report_id: string | null;
}

interface RestrictionResponse {
  id: string;
  type: 'suspension' | 'ban';
  reason: string;
  created_by_username: string | null;
  created_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  lifted_by_username: string | null;
  lift_reason: string | null;
  report_id: string | null;
  active: boolean;
}

interface HistoryResponse {
  items: RestrictionResponse[];
  page: number;
  limit: number;
  total: number;
}

const PASSWORD = 'correct horse battery staple';
const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const isActive = (row: RestrictionFixture) =>
  row.lifted_at === null &&
  (row.expires_at === null || row.expires_at.getTime() > Date.now());

describe('Admin restrictions API (e2e)', () => {
  let app: INestApplication<App>;
  let passwordHash: string;
  let users: Map<string, UserFixture>;
  let sessions: Map<string, string>;
  let restrictions: RestrictionFixture[];
  let auditRows: unknown[][];
  let revokedUsers: string[];
  let failAuditInsert: boolean;
  let failRevocation: boolean;
  let notificationRows: Array<Record<string, unknown>>;
  let failNotificationInsert: boolean;

  beforeAll(async () => {
    passwordHash = await hash(PASSWORD, {
      type: argon2id,
      memoryCost: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    });
  });

  beforeEach(async () => {
    users = new Map([
      [
        'admin-id',
        { username: 'admin', email: 'admin@example.test', role: 'admin' },
      ],
      [
        'other-admin-id',
        { username: 'other_admin', email: 'other@example.test', role: 'admin' },
      ],
      [
        'target-id',
        { username: 'target', email: 'target@example.test', role: 'user' },
      ],
      [
        'user-id',
        { username: 'member', email: 'member@example.test', role: 'user' },
      ],
    ]);
    sessions = new Map([
      [hashToken('admin-token'), 'admin-id'],
      [hashToken('target-token'), 'target-id'],
      [hashToken('user-token'), 'user-id'],
    ]);
    restrictions = [];
    auditRows = [];
    revokedUsers = [];
    failAuditInsert = false;
    failRevocation = false;
    notificationRows = [];
    failNotificationInsert = false;

    const activeRestriction = (userId: unknown) =>
      restrictions.find((row) => row.user_id === userId && isActive(row));
    const restrictionRow = (row: RestrictionFixture) => ({
      id: row.id,
      type: row.type,
      reason: row.reason,
      created_by_username: row.created_by
        ? (users.get(row.created_by)?.username ?? null)
        : null,
      created_at: row.created_at,
      expires_at: row.expires_at,
      lifted_at: row.lifted_at,
      lifted_by_username: row.lifted_by
        ? (users.get(row.lifted_by)?.username ?? null)
        : null,
      lift_reason: row.lift_reason,
      report_id: row.report_id,
      active: isActive(row) ? 1 : 0,
    });

    let undo: Array<() => void> = [];
    const result = (value: unknown) =>
      Promise.resolve([value, []] as [unknown, unknown]);

    const execute = (sql: string, values: unknown[]) => {
      // Authentication (Draft 10 enforcement path) and admin role lookup.
      if (sql.startsWith('SELECT auth_sessions.user_id AS id')) {
        const userId = sessions.get(String(values[0]));
        if (!userId) return result([]);
        const restriction = activeRestriction(userId);
        return result([
          {
            id: userId,
            restriction_type: restriction?.type ?? null,
            restriction_expires_at: restriction?.expires_at ?? null,
          },
        ]);
      }
      if (sql.includes('SET last_seen_at = UTC_TIMESTAMP()')) {
        return result({ affectedRows: 1 });
      }
      if (sql === 'SELECT role FROM users WHERE id = ? LIMIT 1') {
        const user = users.get(String(values[0]));
        return result(user ? [{ role: user.role }] : []);
      }
      if (
        sql.startsWith('SELECT id, username, email, password_hash, created_at')
      ) {
        const entry = [...users.entries()].find(
          ([, user]) => user.email === values[0] || user.username === values[1],
        );
        return result(
          entry
            ? [
                {
                  id: entry[0],
                  username: entry[1].username,
                  email: entry[1].email,
                  password_hash: passwordHash,
                  created_at: new Date('2026-01-01T00:00:00Z'),
                },
              ]
            : [],
        );
      }
      if (sql.startsWith('UPDATE users SET password_hash')) {
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('SELECT type, expires_at')) {
        const restriction = activeRestriction(values[0]);
        return result(restriction ? [restriction] : []);
      }
      if (sql.startsWith('INSERT INTO auth_sessions')) {
        sessions.set(String(values[0]), String(values[1]));
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('INSERT INTO auth_refresh_tokens')) {
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('SELECT token_hash FROM auth_refresh_tokens')) {
        return result([]);
      }
      if (sql === 'DELETE FROM auth_sessions WHERE user_id = ?') {
        if (failRevocation) {
          return Promise.reject(new Error('Revocation failed'));
        }
        for (const [tokenHash, userId] of sessions) {
          if (userId === values[0]) sessions.delete(tokenHash);
        }
        revokedUsers.push(String(values[0]));
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('UPDATE auth_refresh_tokens SET revoked_at')) {
        return result({ affectedRows: 0 });
      }
      // A protected member route used to prove normal access.
      if (sql === 'SELECT id FROM communities WHERE name = ? LIMIT 1') {
        return result(values[0] === 'general' ? [{ id: 'community-1' }] : []);
      }
      if (sql.startsWith('INSERT INTO community_subscriptions')) {
        return result({ affectedRows: 1 });
      }

      // Restriction service.
      if (
        sql === 'SELECT id FROM users WHERE id = ? LIMIT 1' ||
        sql === 'SELECT id, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE'
      ) {
        const user = users.get(String(values[0]));
        return result(user ? [{ id: values[0], role: user.role }] : []);
      }
      if (sql === 'SELECT id FROM user_reports WHERE id = ? LIMIT 1') {
        return result(values[0] === 'report-1' ? [{ id: 'report-1' }] : []);
      }
      if (sql.startsWith('SELECT id FROM user_restrictions')) {
        const restriction = activeRestriction(values[0]);
        return result(restriction ? [{ id: restriction.id }] : []);
      }
      if (sql.startsWith('INSERT INTO user_restrictions')) {
        const withDuration = sql.includes('INTERVAL ? HOUR');
        const id = String(values[0]);
        restrictions.push({
          id,
          user_id: String(values[1]),
          type: values[2] as 'suspension' | 'ban',
          reason: String(values[3]),
          created_by: String(values[4]),
          created_at: new Date(),
          expires_at: withDuration
            ? new Date(Date.now() + Number(values[5]) * 3_600_000)
            : null,
          lifted_at: null,
          lifted_by: null,
          lift_reason: null,
          report_id: (values[withDuration ? 6 : 5] as string | null) ?? null,
        });
        undo.push(() => {
          restrictions = restrictions.filter((row) => row.id !== id);
        });
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('UPDATE user_restrictions')) {
        const row = restrictions.find(
          (candidate) =>
            candidate.id === values[2] &&
            candidate.user_id === values[3] &&
            candidate.lifted_at === null,
        );
        if (row) {
          row.lifted_at = new Date();
          row.lifted_by = String(values[0]);
          row.lift_reason = String(values[1]);
          undo.push(() => {
            row.lifted_at = null;
            row.lifted_by = null;
            row.lift_reason = null;
          });
        }
        return result({ affectedRows: row ? 1 : 0 });
      }
      if (sql.startsWith('SELECT id, user_id, lifted_at')) {
        return result(restrictions.filter((row) => row.id === values[0]));
      }
      if (sql.startsWith('SELECT r.id') && sql.includes('WHERE r.id = ?')) {
        return result(
          restrictions
            .filter((row) => row.id === values[0] && row.user_id === values[1])
            .map(restrictionRow),
        );
      }
      if (sql.startsWith('SELECT r.id')) {
        const [userId, limit, offset] = values as [string, number, number];
        return result(
          restrictions
            .filter((row) => row.user_id === userId)
            .sort(
              (left, right) =>
                right.created_at.getTime() - left.created_at.getTime() ||
                right.id.localeCompare(left.id),
            )
            .slice(offset, offset + limit)
            .map(restrictionRow),
        );
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM user_restrictions')) {
        return result([
          {
            total: restrictions.filter((row) => row.user_id === values[0])
              .length,
          },
        ]);
      }
      if (sql === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
        const user = users.get(String(values[0]));
        return result(user ? [{ username: user.username }] : []);
      }
      if (sql.startsWith('INSERT INTO notifications')) {
        if (failNotificationInsert) {
          return Promise.reject(new Error('Notification insert failed'));
        }
        const row: Record<string, unknown> = {
          id: values[0],
          recipient_id: values[1],
          type: values[2],
          actor_id: values[3],
          subject_type: values[4],
          subject_id: values[5],
          community_id: values[6],
          metadata: values[7],
          read_at: null,
          created_at: new Date(),
        };
        notificationRows.push(row);
        undo.push(() => {
          notificationRows = notificationRows.filter(
            (stored) => stored !== row,
          );
        });
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM notifications')) {
        return result([
          {
            total: notificationRows.filter(
              (row) => row.recipient_id === values[0],
            ).length,
          },
        ]);
      }
      if (
        sql.startsWith('SELECT id, type, subject_type') &&
        sql.includes('FROM notifications WHERE recipient_id = ?')
      ) {
        return result(
          notificationRows.filter((row) => row.recipient_id === values[0]),
        );
      }
      if (sql.startsWith('INSERT INTO admin_actions')) {
        if (failAuditInsert) {
          return Promise.reject(new Error('Audit insert failed'));
        }
        auditRows.push(values);
        return result({ affectedRows: 1 });
      }
      return Promise.reject(new Error(`Unexpected SQL query: ${sql}`));
    };

    const connection = {
      execute,
      beginTransaction: () => {
        undo = [];
        return Promise.resolve();
      },
      commit: () => {
        undo = [];
        return Promise.resolve();
      },
      rollback: () => {
        undo.reverse().forEach((step) => step());
        undo = [];
        return Promise.resolve();
      },
      release: () => undefined,
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute,
        getConnection: () => Promise.resolve(connection),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({
        enforceLogin: () => Promise.resolve(null),
        enforceRegistration: () => Promise.resolve(null),
        enforceRefresh: () => Promise.resolve(null),
      })
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
    Logger.overrideLogger(false);
  });

  afterEach(async () => {
    await app.close();
  });

  const as = (token: string) => ({
    get: (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`),
  });
  const admin = as('admin-token');
  const applyPath = '/admin/users/target-id/restrictions';

  const expectNoSecrets = (body: unknown) => {
    const serialised = JSON.stringify(body);
    for (const forbidden of [
      'email',
      'password',
      '@example.test',
      'token',
      'session',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  };

  it('requires authentication and platform-admin authorization', async () => {
    const server = request(app.getHttpServer());
    await server.get(applyPath).expect(401);
    await server.post(applyPath).send({ type: 'ban', reason: 'X' }).expect(401);
    await server
      .post(`${applyPath}/restriction-1/lift`)
      .send({ lift_reason: 'X' })
      .expect(401);

    const member = as('user-token');
    await member.get(applyPath).expect(403);
    await member.post(applyPath).send({ type: 'ban', reason: 'X' }).expect(403);
    await member
      .post(`${applyPath}/restriction-1/lift`)
      .send({ lift_reason: 'X' })
      .expect(403);
    expect(restrictions).toHaveLength(0);
  });

  it('applies a suspension and a ban with the expected rows and audit entries', async () => {
    const suspension = await admin
      .post(applyPath)
      .send({ type: 'suspension', reason: ' Spam ', duration_hours: 48 })
      .expect(201);
    const body = suspension.body as RestrictionResponse;
    expect(body).toMatchObject({
      type: 'suspension',
      reason: 'Spam',
      created_by_username: 'admin',
      active: true,
      lifted_at: null,
    });
    const hours =
      (Date.parse(String(body.expires_at)) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThanOrEqual(48);
    expect(restrictions[0].created_by).toBe('admin-id');
    expect(auditRows.map((row) => row[3])).toEqual(['user_suspended']);
    expectNoSecrets(body);

    await admin
      .post('/admin/users/user-id/restrictions')
      .send({ type: 'ban', reason: 'Abuse', report_id: 'report-1' })
      .expect(201)
      .expect(({ body: ban }) => {
        expect(ban).toMatchObject({
          type: 'ban',
          expires_at: null,
          report_id: 'report-1',
          active: true,
        });
      });
    expect(auditRows.map((row) => row[3])).toEqual([
      'user_suspended',
      'user_banned',
    ]);
  });

  it.each([
    { type: 'suspension', reason: 'X' },
    { type: 'ban', reason: 'X', duration_hours: 24 },
    { type: 'suspension', reason: 'X', duration_hours: 0 },
    { type: 'suspension', reason: 'X', duration_hours: -5 },
    { type: 'suspension', reason: 'X', duration_hours: 1.5 },
    { type: 'suspension', reason: 'X', duration_hours: 8761 },
    { type: 'ban', reason: 'X', created_by: 'user-id' },
    { type: 'ban', reason: 'X', expires_at: '2020-01-01T00:00:00Z' },
    { type: 'ban', reason: 'X', lifted_at: '2020-01-01T00:00:00Z' },
    { type: 'ban', reason: 'X', extra: true },
    { type: 'ban', reason: '' },
  ])('rejects an invalid apply body with 400: %o', async (body) => {
    await admin.post(applyPath).send(body).expect(400);
    expect(restrictions).toHaveLength(0);
  });

  it('returns 404 for unknown users and reports, 400 for malformed ids', async () => {
    await admin
      .post('/admin/users/missing-id/restrictions')
      .send({ type: 'ban', reason: 'X' })
      .expect(404);
    await admin
      .post(applyPath)
      .send({ type: 'ban', reason: 'X', report_id: 'missing-report' })
      .expect(404);
    await admin
      .post('/admin/users/bad%20id/restrictions')
      .send({ type: 'ban', reason: 'X' })
      .expect(400);
    await admin.get('/admin/users/missing-id/restrictions').expect(404);
    expect(restrictions).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
  });

  it('refuses stacking, self-restriction and administrator targets', async () => {
    await admin.post(applyPath).send({ type: 'ban', reason: 'X' }).expect(201);
    await admin
      .post(applyPath)
      .send({ type: 'suspension', reason: 'Y', duration_hours: 1 })
      .expect(409);
    await admin
      .post('/admin/users/admin-id/restrictions')
      .send({ type: 'ban', reason: 'X' })
      .expect(403);
    await admin
      .post('/admin/users/other-admin-id/restrictions')
      .send({ type: 'ban', reason: 'X' })
      .expect(403);
    expect(restrictions).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
  });

  it('rolls back the restriction when the audit write fails', async () => {
    failAuditInsert = true;
    await admin.post(applyPath).send({ type: 'ban', reason: 'X' }).expect(500);
    expect(restrictions).toHaveLength(0);
    expect(revokedUsers).toHaveLength(0);
  });

  it('applies, then denies the restricted account on its existing token and at login', async () => {
    const target = as('target-token');
    await target.post('/communities/general/subscribe').expect(204);

    await admin
      .post(applyPath)
      .send({ type: 'ban', reason: 'Abuse' })
      .expect(201);
    expect(revokedUsers).toEqual(['target-id']);

    await target.post('/communities/general/subscribe').expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: 'target', password: PASSWORD })
      .expect(403)
      .expect(({ body }) => {
        expect(JSON.stringify(body)).toContain('ban');
        expect(JSON.stringify(body)).not.toContain('Abuse');
      });
  });

  it('keeps the restriction and still denies old tokens when revocation fails', async () => {
    failRevocation = true;

    await admin
      .post(applyPath)
      .send({ type: 'suspension', reason: 'Spam', duration_hours: 2 })
      .expect(201);

    expect(restrictions).toHaveLength(1);
    expect(sessions.has(hashToken('target-token'))).toBe(true);
    await as('target-token')
      .post('/communities/general/subscribe')
      .expect(403)
      .expect(({ body }) => {
        expect(JSON.stringify(body)).toContain('suspension');
        expect(JSON.stringify(body)).not.toContain('Spam');
      });
  });

  it('lifts, then lets the account sign in again without restoring old sessions', async () => {
    const applied = await admin
      .post(applyPath)
      .send({ type: 'suspension', reason: 'Spam', duration_hours: 24 })
      .expect(201);
    const { id } = applied.body as RestrictionResponse;

    const lifted = await admin
      .post(`${applyPath}/${id}/lift`)
      .send({ lift_reason: ' Appeal accepted ' })
      .expect(200);
    expect(lifted.body).toMatchObject({
      id,
      active: false,
      lift_reason: 'Appeal accepted',
      lifted_by_username: 'admin',
    });
    expect((lifted.body as RestrictionResponse).lifted_at).not.toBeNull();
    expect(auditRows.map((row) => row[3])).toEqual([
      'user_suspended',
      'restriction_lifted',
    ]);
    expectNoSecrets(lifted.body);

    await as('target-token').post('/communities/general/subscribe').expect(401);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ identifier: 'target', password: PASSWORD })
      .expect(200);
    const { accessToken } = login.body as { accessToken: string };
    await as(accessToken).post('/communities/general/subscribe').expect(204);
  });

  it('distinguishes 409 and 404 when lifting', async () => {
    const applied = await admin
      .post(applyPath)
      .send({ type: 'ban', reason: 'X' })
      .expect(201);
    const { id } = applied.body as RestrictionResponse;

    await admin
      .post(`/admin/users/user-id/restrictions/${id}/lift`)
      .send({ lift_reason: 'Wrong user' })
      .expect(404);
    await admin
      .post(`${applyPath}/missing/lift`)
      .send({ lift_reason: 'X' })
      .expect(404);
    await admin.post(`${applyPath}/${id}/lift`).send({}).expect(400);
    await admin
      .post(`${applyPath}/${id}/lift`)
      .send({ lift_reason: 'X', lifted_by: 'user-id' })
      .expect(400);
    await admin
      .post(`${applyPath}/${id}/lift`)
      .send({ lift_reason: 'Closed' })
      .expect(200);
    await admin
      .post(`${applyPath}/${id}/lift`)
      .send({ lift_reason: 'Again' })
      .expect(409);
    expect(auditRows.map((row) => row[3])).toEqual([
      'user_banned',
      'restriction_lifted',
    ]);
  });

  it('lifts an expired suspension to close the case', async () => {
    restrictions.push({
      id: 'expired',
      user_id: 'target-id',
      type: 'suspension',
      reason: 'Old',
      created_by: 'admin-id',
      created_at: new Date('2026-01-01T00:00:00Z'),
      expires_at: new Date('2026-01-02T00:00:00Z'),
      lifted_at: null,
      lifted_by: null,
      lift_reason: null,
      report_id: null,
    });

    await admin
      .post(`${applyPath}/expired/lift`)
      .send({ lift_reason: 'Closing' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ active: false, lift_reason: 'Closing' });
      });
  });

  it('returns paginated history newest first, tolerating deleted admins', async () => {
    await admin
      .get(applyPath)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ items: [], page: 1, limit: 20, total: 0 });
      });

    restrictions.push(
      {
        id: 'first',
        user_id: 'target-id',
        type: 'suspension',
        reason: 'Old',
        created_by: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        expires_at: new Date('2026-01-02T00:00:00Z'),
        lifted_at: new Date('2026-01-01T12:00:00Z'),
        lifted_by: null,
        lift_reason: 'Appeal',
        report_id: null,
      },
      {
        id: 'second',
        user_id: 'target-id',
        type: 'ban',
        reason: 'Recent',
        created_by: 'admin-id',
        created_at: new Date('2026-02-01T00:00:00Z'),
        expires_at: null,
        lifted_at: null,
        lifted_by: null,
        lift_reason: null,
        report_id: 'report-1',
      },
    );

    const page = await admin.get(`${applyPath}?limit=1&page=1`).expect(200);
    const body = page.body as HistoryResponse;
    expect(body).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(body.items).toEqual([
      expect.objectContaining({ id: 'second', active: true }),
    ]);
    const next = await admin.get(`${applyPath}?limit=1&page=2`).expect(200);
    expect((next.body as HistoryResponse).items[0]).toMatchObject({
      id: 'first',
      active: false,
      created_by_username: null,
      lifted_by_username: null,
    });
    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        'active',
        'created_at',
        'created_by_username',
        'expires_at',
        'id',
        'lift_reason',
        'lifted_at',
        'lifted_by_username',
        'reason',
        'report_id',
        'type',
      ].sort(),
    );
    expectNoSecrets(body);

    await admin.get(`${applyPath}?limit=101`).expect(400);
    await admin.get(`${applyPath}?page=0`).expect(400);
  });

  describe('notifications', () => {
    const expectNoModerationLeaks = (body: unknown) => {
      const serialised = JSON.stringify(body);
      for (const leaked of [
        'reason',
        'lift_reason',
        'created_by',
        'lifted_by',
        'report_id',
        'admin',
        'Spam',
        'Appeal',
        'report-1',
      ]) {
        expect(serialised).not.toContain(leaked);
      }
    };

    it('tells the user they were suspended and then lifted, and never why or by whom', async () => {
      const applied = await admin
        .post(applyPath)
        .send({
          type: 'suspension',
          reason: 'Spam',
          duration_hours: 24,
          report_id: 'report-1',
        })
        .expect(201);
      const { id, expires_at } = applied.body as RestrictionResponse;
      await admin
        .post(`${applyPath}/${id}/lift`)
        .send({ lift_reason: 'Appeal accepted' })
        .expect(200);

      expect(notificationRows).toHaveLength(2);
      for (const row of notificationRows) {
        expect(row).toMatchObject({
          recipient_id: 'target-id',
          actor_id: null,
          subject_type: 'restriction',
          subject_id: id,
          community_id: null,
        });
      }
      expect(
        notificationRows.map((row) => [
          row.type,
          JSON.parse(String(row.metadata)) as unknown,
        ]),
      ).toEqual([
        ['restriction_applied', { restriction_type: 'suspension', expires_at }],
        ['restriction_lifted', { restriction_type: 'suspension' }],
      ]);
      expect(auditRows.map((row) => row[3])).toEqual([
        'user_suspended',
        'restriction_lifted',
      ]);

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ identifier: 'target', password: PASSWORD })
        .expect(200);
      const { accessToken } = login.body as { accessToken: string };
      const inbox = await as(accessToken).get('/notifications').expect(200);
      const body = inbox.body as {
        total: number;
        items: Array<Record<string, unknown>>;
      };
      expect(body.total).toBe(2);
      expect(body.items.map((item) => item.type).sort()).toEqual([
        'restriction_applied',
        'restriction_lifted',
      ]);
      for (const item of body.items) {
        expect(item.actor_username).toBeNull();
      }
      expectNoModerationLeaks(inbox.body);
    });

    it('tells a banned user the type only, readable while the ban is active', async () => {
      failRevocation = true;
      await admin
        .post(applyPath)
        .send({ type: 'ban', reason: 'Spam' })
        .expect(201);

      expect(JSON.parse(String(notificationRows[0].metadata))).toEqual({
        restriction_type: 'ban',
      });
      const inbox = await as('target-token').get('/notifications').expect(200);
      expect((inbox.body as { total: number }).total).toBe(1);
      expectNoModerationLeaks(inbox.body);
    });

    it('rolls the restriction back if the notification cannot be written', async () => {
      failNotificationInsert = true;

      await admin
        .post(applyPath)
        .send({ type: 'ban', reason: 'Spam' })
        .expect(500);

      expect(restrictions).toEqual([]);
      expect(notificationRows).toEqual([]);
      expect(revokedUsers).toEqual([]);
    });
  });
});
