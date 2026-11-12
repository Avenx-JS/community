import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { argon2id, hash } from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import {
  hashOpaqueToken,
  LIST_SESSIONS_SQL,
  MYSQL_POOL,
} from '../src/auth/auth.service';
import {
  APPLY_EMAIL_CHANGE_SQL,
  CONSUME_VERIFICATION_TOKEN_SQL,
  DELETE_EMAIL_CHANGE_SQL,
  EMAIL_CHANGE_OWNER_SQL,
  EMAIL_IN_USE_SQL,
  INSERT_VERIFICATION_TOKEN_SQL,
  INVALIDATE_VERIFICATION_TOKENS_SQL,
  LOCK_EMAIL_ACCOUNT_SQL,
  LOCK_EMAIL_CHANGE_SQL,
  LOCK_VERIFICATION_TOKEN_SQL,
  MARK_VERIFIED_SQL,
  UPSERT_EMAIL_CHANGE_SQL,
  VERIFICATION_TOKEN_OWNER_SQL,
} from '../src/auth/email-verification.service';
import {
  EmailTransport,
  type OutboundMessage,
} from '../src/email/email-transport';
import {
  EXPIRE_EXPORTS_SQL,
  EXPORT_SECTIONS,
  FAIL_STALE_EXPORTS_SQL,
} from '../src/users/data-export.service';
import {
  UPSERT_USER_PREFERENCES_SQL,
  USER_PREFERENCES_SQL,
} from '../src/users/user-preferences.service';

const PASSWORD = 'correct-horse-battery';

// Email verification and change, the session list, preferences and the data
// export over HTTP, with the real AuthService and EmailVerificationService
// over an in-memory model of their statements. Mail goes to an inbox array.
describe('Account settings (e2e)', () => {
  let app: INestApplication<App>;
  let passwordHash: string;
  let users: Array<{
    id: string;
    username: string;
    email: string;
    email_verified_at: Date | null;
    password_hash: string;
  }>;
  let sessions: Array<{
    token_hash: string;
    user_id: string;
    session_id: string;
    created_at: Date;
    last_used_at: Date | null;
    ip_prefix: string | null;
    user_agent: string | null;
    expires_at: Date;
  }>;
  let refresh: Array<{
    session_id: string;
    user_id: string;
    revoked_at: Date | null;
  }>;
  let tokens: Array<{
    token_hash: string;
    user_id: string;
    email: string;
    used_at: Date | null;
    expires_at: number;
  }>;
  let changes: Array<{
    user_id: string;
    new_email: string;
    token_hash: string;
    expires_at: number;
  }>;
  let preferences: Map<string, unknown[]>;
  let exports: Array<{
    id: string;
    user_id: string;
    status: string;
    payload: Buffer | null;
    created_at: Date;
    expires_at: Date | null;
  }>;
  let inbox: OutboundMessage[];

  beforeAll(async () => {
    passwordHash = await hash(PASSWORD, {
      type: argon2id,
      version: 0x13,
      memoryCost: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    });
  });

  beforeEach(async () => {
    users = [
      {
        id: 'u-a',
        username: 'alice',
        email: 'alice@example.com',
        email_verified_at: null,
        password_hash: passwordHash,
      },
      {
        id: 'u-b',
        username: 'bob',
        email: 'bob@example.com',
        email_verified_at: new Date(),
        password_hash: passwordHash,
      },
    ];
    const session = (
      token: string,
      user: string,
      id: string,
      minutesAgo: number,
    ) => ({
      token_hash: hashOpaqueToken(token),
      user_id: user,
      session_id: id,
      created_at: new Date(Date.now() - minutesAgo * 60_000),
      last_used_at: new Date(Date.now() - minutesAgo * 30_000),
      ip_prefix: '203.0.113.0/24',
      user_agent: 'Firefox',
      expires_at: new Date(Date.now() + 600_000),
    });
    sessions = [
      session('token-a', 'u-a', 's-a1', 10),
      session('token-a2', 'u-a', 's-a2', 60),
      session('token-b', 'u-b', 's-b1', 5),
    ];
    refresh = sessions.map(({ session_id, user_id }) => ({
      session_id,
      user_id,
      revoked_at: null,
    }));
    tokens = [];
    changes = [];
    preferences = new Map();
    exports = [];
    inbox = [];
    const now = () => Date.now();

    const execute = (sql: string, values: unknown[] = []): unknown => {
      const v = values as string[];
      // Authentication.
      if (sql.startsWith('SELECT auth_sessions.user_id AS id')) {
        const s = sessions.find(
          (x) => x.token_hash === v[0] && x.expires_at.getTime() > now(),
        );
        const user = users.find((u) => u.id === s?.user_id);
        return [
          s && user
            ? [
                {
                  id: s.user_id,
                  email_verified: user.email_verified_at ? 1 : 0,
                  restriction_type: null,
                },
              ]
            : [],
          [],
        ];
      }
      if (sql.includes('SET last_seen_at = UTC_TIMESTAMP()'))
        return [{ affectedRows: 1 }, []];
      // Sessions.
      if (sql === LIST_SESSIONS_SQL) {
        return [
          sessions.filter(
            (s) =>
              s.user_id === v[0] &&
              refresh.some(
                (r) => r.session_id === s.session_id && !r.revoked_at,
              ),
          ),
          [],
        ];
      }
      if (
        sql.startsWith(
          'SELECT token_hash FROM auth_refresh_tokens WHERE session_id = ? AND user_id = ?',
        )
      )
        return [[], []];
      if (
        sql === 'DELETE FROM auth_sessions WHERE session_id = ? AND user_id = ?'
      ) {
        const before = sessions.length;
        sessions = sessions.filter(
          (s) => !(s.session_id === v[0] && s.user_id === v[1]),
        );
        return [{ affectedRows: before - sessions.length }, []];
      }
      if (
        sql.startsWith(
          'UPDATE auth_refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE session_id = ? AND user_id = ?',
        )
      ) {
        let affectedRows = 0;
        for (const r of refresh) {
          if (r.session_id === v[0] && r.user_id === v[1] && !r.revoked_at) {
            r.revoked_at = new Date();
            affectedRows += 1;
          }
        }
        return [{ affectedRows }, []];
      }
      // Email verification and change.
      switch (sql) {
        case LOCK_EMAIL_ACCOUNT_SQL:
          return [
            users.filter((u) => u.id === v[0]).map((u) => ({ ...u })),
            [],
          ];
        case INVALIDATE_VERIFICATION_TOKENS_SQL:
          for (const t of tokens)
            if (t.user_id === v[0] && !t.used_at) t.used_at = new Date();
          return [{ affectedRows: 1 }, []];
        case INSERT_VERIFICATION_TOKEN_SQL:
          tokens.push({
            token_hash: v[0],
            user_id: v[1],
            email: v[2],
            used_at: null,
            expires_at: now() + Number(v[3]) * 1000,
          });
          return [{ affectedRows: 1 }, []];
        case VERIFICATION_TOKEN_OWNER_SQL:
          return [tokens.filter((t) => t.token_hash === v[0]), []];
        case LOCK_VERIFICATION_TOKEN_SQL:
          return [
            tokens
              .filter((t) => t.token_hash === v[0])
              .map((t) => ({ ...t, expired: t.expires_at <= now() ? 1 : 0 })),
            [],
          ];
        case CONSUME_VERIFICATION_TOKEN_SQL: {
          const t = tokens.find((x) => x.token_hash === v[0] && !x.used_at);
          if (t) t.used_at = new Date();
          return [{ affectedRows: t ? 1 : 0 }, []];
        }
        case MARK_VERIFIED_SQL: {
          const u = users.find((x) => x.id === v[0] && x.email === v[1]);
          if (u) u.email_verified_at ??= new Date();
          return [{ affectedRows: 1 }, []];
        }
        case EMAIL_IN_USE_SQL:
          return [
            users.filter((u) => u.email === v[0]).map(({ id }) => ({ id })),
            [],
          ];
        case UPSERT_EMAIL_CHANGE_SQL:
          changes = changes.filter((c) => c.user_id !== v[0]);
          changes.push({
            user_id: v[0],
            new_email: v[1],
            token_hash: v[2],
            expires_at: now() + Number(v[3]) * 1000,
          });
          return [{ affectedRows: 1 }, []];
        case EMAIL_CHANGE_OWNER_SQL:
          return [changes.filter((c) => c.token_hash === v[0]), []];
        case LOCK_EMAIL_CHANGE_SQL:
          return [
            changes
              .filter((c) => c.token_hash === v[0])
              .map((c) => ({ ...c, expired: 0 })),
            [],
          ];
        case APPLY_EMAIL_CHANGE_SQL:
          Object.assign(
            users.find((u) => u.id === v[1])!,
            { email: v[0], email_verified_at: new Date() },
          );
          return [{ affectedRows: 1 }, []];
        case DELETE_EMAIL_CHANGE_SQL:
          changes = changes.filter((c) => c.user_id !== v[0]);
          return [{ affectedRows: 1 }, []];
        case USER_PREFERENCES_SQL: {
          const row = preferences.get(v[0]);
          return [
            row
              ? [
                  {
                    email_notifications: row[0],
                    new_community_notifications: row[1],
                    show_nsfw: row[2],
                    timezone: row[3],
                    language: row[4],
                  },
                ]
              : [],
            [],
          ];
        }
        case UPSERT_USER_PREFERENCES_SQL:
          preferences.set(v[0], values.slice(1));
          return [{ affectedRows: 1 }, []];
        case EXPIRE_EXPORTS_SQL:
        case FAIL_STALE_EXPORTS_SQL:
          return [{ affectedRows: 0 }, []];
      }
      if (sql.startsWith('UPDATE password_reset_tokens SET used_at'))
        return [{ affectedRows: 0 }, []];
      // Exports.
      if (
        sql.startsWith(
          'SELECT id FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
        )
      )
        return [[{ id: v[0] }], []];
      if (
        sql.startsWith(
          "SELECT id FROM data_exports WHERE user_id = ? AND status = 'pending'",
        )
      ) {
        return [
          exports.filter((e) => e.user_id === v[0] && e.status === 'pending'),
          [],
        ];
      }
      if (sql.startsWith('INSERT INTO data_exports')) {
        exports.push({
          id: v[0],
          user_id: v[1],
          status: 'pending',
          payload: null,
          created_at: new Date(),
          expires_at: null,
        });
        return [{ affectedRows: 1 }, []];
      }
      if (
        sql.startsWith(
          'SELECT id, status, created_at, expires_at FROM data_exports',
        )
      ) {
        return [exports.filter((e) => e.id === v[0] && e.user_id === v[1]), []];
      }
      if (EXPORT_SECTIONS.some(([, statement]) => statement === sql)) {
        return [
          sql.startsWith('SELECT username, email')
            ? users
                .filter((u) => u.id === v[0])
                .map(({ username, email }) => ({ username, email }))
            : [],
          [],
        ];
      }
      if (sql.startsWith("UPDATE data_exports SET status = 'ready'")) {
        const e = exports.find((x) => x.id === values[3])!;
        Object.assign(e, {
          status: 'ready',
          payload: values[0],
          expires_at: new Date(now() + 3600_000),
        });
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith('SELECT payload FROM data_exports')) {
        return [
          exports.filter(
            (e) => e.id === v[0] && e.user_id === v[1] && e.status === 'ready',
          ),
          [],
        ];
      }
      if (sql.startsWith("UPDATE data_exports SET status = 'downloaded'")) {
        Object.assign(
          exports.find((x) => x.id === v[0])!,
          { status: 'downloaded', payload: null },
        );
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    const promised = (sql: string, values?: unknown[]) => {
      try {
        return Promise.resolve(execute(sql, values));
      } catch (error) {
        return Promise.reject(error as Error);
      }
    };
    const pool = {
      execute: promised,
      query: promised,
      getConnection: () =>
        Promise.resolve({
          execute: promised,
          query: promised,
          beginTransaction: () => Promise.resolve(),
          commit: () => Promise.resolve(),
          rollback: () => Promise.resolve(),
          release: () => undefined,
        }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue(pool)
      .overrideProvider(EmailTransport)
      .useValue({
        send: (message: OutboundMessage) => {
          inbox.push(message);
          return Promise.resolve();
        },
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({
        enforceApiRequest: () => Promise.resolve(null),
        enforceEmailVerifyRequest: () => Promise.resolve(null),
        enforceEmailVerify: () => Promise.resolve(null),
        enforceEmailChange: () => Promise.resolve(null),
        enforceDataExport: () => Promise.resolve(null),
      })
      .compile();
    app = moduleFixture.createNestApplication();
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

  const as = (token: string | null) => {
    const auth = <T extends { set: (k: string, v: string) => T }>(call: T) =>
      token ? call.set('Authorization', `Bearer ${token}`) : call;
    const server = () => request(app.getHttpServer());
    return {
      get: (path: string) => auth(server().get(path)),
      post: (path: string, body: object = {}) =>
        auth(server().post(path)).send(body),
      put: (path: string, body: object) => auth(server().put(path)).send(body),
      patch: (path: string, body: object) =>
        auth(server().patch(path)).send(body),
      delete: (path: string) => auth(server().delete(path)),
    };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
  const codeIn = (message?: OutboundMessage) =>
    /\n\n([A-Za-z0-9_-]{43})\n\n/.exec(message?.text ?? '')?.[1];

  describe('email verification', () => {
    it('refuses creating content until the address is confirmed, and lets it through after', async () => {
      for (const [path, body] of [
        [
          '/posts',
          { title: 't', type: 'text', content: 'c', community_id: 'c-1' },
        ],
        ['/posts/p-1/comments', { content: 'c' }],
        ['/communities', { name: 'garden' }],
      ] as const) {
        const refusal: unknown = (
          await as('token-a').post(path, body).expect(403)
        ).body;
        expect(refusal).toMatchObject({ reason: 'email_unverified' });
      }

      await as('token-a').post('/auth/email/verify-request').expect(202);
      await flush();
      expect(inbox.map((m) => m.to)).toEqual(['alice@example.com']);
      const code = codeIn(inbox[0])!;
      expect(tokens[0].token_hash).toBe(hashOpaqueToken(code));

      // The code alone, without a bearer token.
      const body: unknown = (
        await as(null).post('/auth/email/verify', { token: code }).expect(200)
      ).body;
      expect(body).toEqual({ status: 'verified', email: 'alice@example.com' });
      await as(null).post('/auth/email/verify', { token: code }).expect(400);
      await as('token-a').post('/auth/email/verify-request').expect(409);
    });

    it('validates input and needs a token to request a code', async () => {
      await as(null).post('/auth/email/verify-request').expect(401);
      await as(null).post('/auth/email/verify', {}).expect(400);
      await as(null)
        .post('/auth/email/verify', { token: 'bad token!' })
        .expect(400);
      await as(null)
        .post('/auth/email/verify', { token: 'unknown' })
        .expect(400);
    });
  });

  describe('PATCH /users/me/email', () => {
    it('needs the password, and changes the address only after the new one confirms', async () => {
      await as('token-b')
        .patch('/users/me/email', {
          new_email: 'new@example.com',
          current_password: 'wrong-password-x',
        })
        .expect(401);
      const body: unknown = (
        await as('token-b')
          .patch('/users/me/email', {
            new_email: 'new@example.com',
            current_password: PASSWORD,
          })
          .expect(202)
      ).body;
      await flush();
      expect(users[1].email).toBe('bob@example.com');
      expect(inbox.map((m) => m.to).sort()).toEqual([
        'bob@example.com',
        'new@example.com',
      ]);

      // The same answer for an address another account has.
      const taken = await as('token-b')
        .patch('/users/me/email', {
          new_email: 'alice@example.com',
          current_password: PASSWORD,
        })
        .expect(202);
      expect(taken.body).toEqual(body);
      await flush();
      expect(
        codeIn(inbox.find((m) => m.to === 'alice@example.com')),
      ).toBeUndefined();

      const code = codeIn(inbox.find((m) => m.to === 'new@example.com'))!;
      await as('token-b')
        .patch('/users/me/email', {
          new_email: 'new@example.com',
          current_password: PASSWORD,
        })
        .expect(202);
      await flush();
      // The repeat replaced the pending change: the first code is void.
      await as(null).post('/auth/email/verify', { token: code }).expect(400);
      const latest = codeIn(
        inbox.filter((m) => m.to === 'new@example.com').at(-1),
      )!;
      const done: unknown = (
        await as(null).post('/auth/email/verify', { token: latest }).expect(200)
      ).body;
      expect(done).toEqual({
        status: 'email_changed',
        email: 'new@example.com',
      });
      expect(users[1].email).toBe('new@example.com');
    });

    it.each([
      [{ new_email: 'not-an-email', current_password: PASSWORD }],
      [{ new_email: 'x@example.com' }],
      [
        {
          new_email: 'x@example.com',
          current_password: PASSWORD,
          email_verified: true,
        },
      ],
    ])('refuses %o with 400', async (body) => {
      await as('token-b').patch('/users/me/email', body).expect(400);
    });
  });

  describe('sessions', () => {
    it('lists them without tokens or full addresses, and ends one at once', async () => {
      const body: unknown = (
        await as('token-a').get('/auth/sessions').expect(200)
      ).body;
      const items = (body as { items: Array<Record<string, unknown>> }).items;
      expect(items.map((item) => [item.id, item.current])).toEqual(
        expect.arrayContaining([
          ['s-a1', true],
          ['s-a2', false],
        ]),
      );
      expect(items).toHaveLength(2);
      expect(JSON.stringify(body)).not.toMatch(
        /token|[0-9a-f]{64}|203\.0\.113\.\d+[^/]/,
      );

      await as('token-a').delete('/auth/sessions/s-a2').expect(204);
      expect(
        refresh.find((r) => r.session_id === 's-a2')?.revoked_at,
      ).not.toBeNull();
      await as('token-a2').get('/auth/sessions').expect(401);
      await as('token-a').delete('/auth/sessions/s-a2').expect(404);
      // Another account's session.
      await as('token-a').delete('/auth/sessions/s-b1').expect(404);
      await as('token-b').get('/auth/sessions').expect(200);
    });
  });

  describe('preferences', () => {
    it('has defaults, refuses an invalid set, and stores a valid one', async () => {
      expect(
        (await as('token-a').get('/users/me/preferences').expect(200)).body,
      ).toEqual({
        email_notifications: true,
        new_community_notifications: true,
        show_nsfw: false,
        timezone: 'UTC',
        language: 'en',
      });
      const set = {
        email_notifications: false,
        new_community_notifications: false,
        show_nsfw: true,
        timezone: 'Europe/Berlin',
        language: 'de',
      };
      await as('token-a')
        .put('/users/me/preferences', { ...set, timezone: 'Nowhere/Here' })
        .expect(400);
      await as('token-a')
        .put('/users/me/preferences', { show_nsfw: true })
        .expect(400);
      expect(
        (await as('token-a').put('/users/me/preferences', set).expect(200))
          .body,
      ).toEqual(set);
      expect(
        (await as('token-a').get('/users/me/preferences').expect(200)).body,
      ).toEqual(set);
    });
  });

  describe('data export', () => {
    it('is prepared asynchronously, downloads once, and is gone afterwards', async () => {
      const body: unknown = (
        await as('token-a').post('/users/me/export').expect(202)
      ).body;
      const id = (body as { id: string; status: string }).id;
      expect(body).toMatchObject({ status: 'pending' });
      await flush();

      await as('token-b').get(`/users/me/export/${id}`).expect(404);
      const file = await as('token-a')
        .get(`/users/me/export/${id}`)
        .expect(200);
      expect(file.headers['content-disposition']).toBe(
        `attachment; filename="community-export-${id}.json"`,
      );
      expect(file.headers['cache-control']).toBe('no-store');
      const data = JSON.parse(file.text) as Record<string, unknown>;
      expect(data).toMatchObject({
        format: 'community-data-export/1',
        account: { username: 'alice' },
      });
      expect(file.text).not.toMatch(/argon2|password/);
      await as('token-a').get(`/users/me/export/${id}`).expect(410);
    });
  });
});
