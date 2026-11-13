import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { get, type IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import {
  AuthService,
  hashOpaqueToken,
  MYSQL_POOL,
} from '../src/auth/auth.service';
import { SessionEvents } from '../src/auth/session-events';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import {
  DELETE_ALL_NOTIFICATIONS_SQL,
  UNREAD_COUNT_SQL,
} from '../src/notifications/notification-inbox.service';
import {
  INSERT_STREAM_TICKET_SQL,
  liveStreamSessionsSql,
  NotificationStreamService,
  recentNotificationsSql,
  STREAM_TICKET_SQL,
  USE_STREAM_TICKET_SQL,
} from '../src/notifications/notification-stream.service';
import {
  DEFAULT_PUSH_ALLOWED_HOSTS,
  PUSH_CONFIG,
  PUSH_TRANSPORT,
  type PushRequest,
} from '../src/notifications/web-push/push-config';
import {
  CLAIM_PUSH_SQL,
  expiredSubscriptionsSql,
  markDispatchedSql,
  PUSH_GONE_SQL,
  PUSH_SUCCEEDED_SQL,
  PushDispatcherService,
  subscriptionsOfSql,
} from '../src/notifications/web-push/push-dispatcher.service';
import {
  COUNT_SUBSCRIPTIONS_SQL,
  DELETE_SUBSCRIPTION_SQL,
  OWN_SUBSCRIPTIONS_SQL,
  SUBSCRIPTION_BY_ENDPOINT_SQL,
  UPSERT_SUBSCRIPTION_SQL,
} from '../src/notifications/web-push/push-subscriptions.service';
import { generateVapidKeys } from '../src/notifications/web-push/web-push-crypto';

const UA_PUBLIC =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/sam-browser';

interface Note {
  id: string;
  recipient_id: string;
  type: string;
  read_at: Date | null;
  pushed: boolean;
}

interface Stream {
  status: number;
  headers: IncomingMessage['headers'];
  events: Array<[string, unknown]>;
  raw: string;
  closed: Promise<void>;
  close: () => void;
}

// GET /notifications/stream, /stream-tickets, DELETE /notifications and the
// push subscriptions, over a fake database; the stream is read from a real
// listening server.
describe('Live notifications (e2e)', () => {
  let app: INestApplication<App>;
  let port: number;
  let notes: Note[];
  let liveTokens: Map<string, string>;
  let tickets: Map<
    string,
    { user_id: string; token_hash: string; used: boolean }
  >;
  let subscriptions: Map<
    string,
    { id: string; user_id: string; endpoint: string }
  >;
  let pushes: PushRequest[];
  let pushStatus: number;
  const streams: Stream[] = [];

  const note = (id: string, recipient: string): Note => ({
    id,
    recipient_id: recipient,
    type: 'post_comment',
    read_at: null,
    pushed: false,
  });
  const row = (entry: Note) => ({
    ...entry,
    subject_type: 'comment',
    subject_id: 'c-1',
    community_id: null,
    metadata: JSON.stringify({ post_title: 'Seeds', actor_username: 'alex' }),
    created_at: new Date('2026-11-13T10:00:00Z'),
  });

  beforeEach(async () => {
    process.env.PUSH_DISPATCH_DISABLED = 'true';
    notes = [note('n-old', 'sam')];
    liveTokens = new Map([
      [hashOpaqueToken('sam-token'), 'sam'],
      [hashOpaqueToken('alex-token'), 'alex'],
    ]);
    tickets = new Map();
    subscriptions = new Map();
    pushes = [];
    pushStatus = 201;

    const run = (sql: string, values: unknown[]): [unknown, unknown] => {
      const rows = (value: unknown): [unknown, unknown] => [value, []];
      const flat = sql.replace(/\s+/g, ' ').trim();
      const count = values.length;

      if (sql === recentNotificationsSql(count - 1)) {
        const recipients = values.slice(0, -1);
        return rows(
          notes.filter((n) => recipients.includes(n.recipient_id)).map(row),
        );
      }
      if (sql === UNREAD_COUNT_SQL) {
        return rows([
          {
            unread: notes.filter(
              (n) => n.recipient_id === values[0] && !n.read_at,
            ).length,
          },
        ]);
      }
      if (sql === liveStreamSessionsSql(count)) {
        return rows(
          (values as string[])
            .filter((hash) => liveTokens.has(hash))
            .map((hash) => ({
              token_hash: hash,
              user_id: liveTokens.get(hash),
            })),
        );
      }
      if (sql === INSERT_STREAM_TICKET_SQL) {
        tickets.set(values[0] as string, {
          user_id: values[1] as string,
          token_hash: values[2] as string,
          used: false,
        });
        return rows({ affectedRows: 1 });
      }
      if (sql === USE_STREAM_TICKET_SQL) {
        const ticket = tickets.get(values[0] as string);
        if (!ticket || ticket.used) return rows({ affectedRows: 0 });
        ticket.used = true;
        return rows({ affectedRows: 1 });
      }
      if (sql === STREAM_TICKET_SQL) {
        const ticket = tickets.get(values[0] as string);
        return rows(ticket ? [ticket] : []);
      }
      if (sql === DELETE_ALL_NOTIFICATIONS_SQL) {
        const before = notes.length;
        notes = notes.filter((n) => n.recipient_id !== values[0]);
        return rows({ affectedRows: before - notes.length });
      }

      // Push subscriptions.
      if (sql === COUNT_SUBSCRIPTIONS_SQL) {
        return rows([
          {
            total: [...subscriptions.values()].filter(
              (s) => s.user_id === values[0],
            ).length,
          },
        ]);
      }
      if (sql === UPSERT_SUBSCRIPTION_SQL) {
        const existing = subscriptions.get(values[3] as string);
        subscriptions.set(values[3] as string, {
          id: existing?.id ?? (values[0] as string),
          user_id: values[1] as string,
          endpoint: values[2] as string,
        });
        return rows({ affectedRows: 1 });
      }
      const subscriptionRow = (s: { id: string; endpoint: string }) => ({
        id: s.id,
        endpoint: s.endpoint,
        user_agent: null,
        created_at: new Date('2026-11-13T09:00:00Z'),
        last_success_at: null,
        expires_at: null,
      });
      if (sql === SUBSCRIPTION_BY_ENDPOINT_SQL) {
        const s = subscriptions.get(values[0] as string);
        return rows(s ? [subscriptionRow(s)] : []);
      }
      if (sql === OWN_SUBSCRIPTIONS_SQL) {
        return rows(
          [...subscriptions.values()]
            .filter((s) => s.user_id === values[0])
            .map(subscriptionRow),
        );
      }
      if (sql === DELETE_SUBSCRIPTION_SQL || sql === PUSH_GONE_SQL) {
        for (const [hash, s] of subscriptions) {
          if (
            s.id === values[0] &&
            (sql === PUSH_GONE_SQL || s.user_id === values[1])
          ) {
            subscriptions.delete(hash);
            return rows({ affectedRows: 1 });
          }
        }
        return rows({ affectedRows: 0 });
      }

      // Push dispatch.
      if (sql === CLAIM_PUSH_SQL) {
        return rows(
          notes
            .filter((n) => !n.pushed)
            .map((n) => ({ ...row(n), deliver: 1 })),
        );
      }
      if (sql === markDispatchedSql(count)) {
        for (const n of notes) if (values.includes(n.id)) n.pushed = true;
        return rows({ affectedRows: count });
      }
      if (sql === expiredSubscriptionsSql(count))
        return rows({ affectedRows: 0 });
      if (sql === subscriptionsOfSql(count)) {
        return rows(
          [...subscriptions.values()]
            .filter((s) => values.includes(s.user_id))
            .map((s) => ({ ...s, p256dh: UA_PUBLIC, auth: AUTH })),
        );
      }
      if (sql === PUSH_SUCCEEDED_SQL) return rows({ affectedRows: 1 });
      throw new Error(`Unexpected SQL: ${flat}`);
    };
    const execute = (sql: string, values: unknown[] = []) =>
      Promise.resolve(run(sql, values));

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute,
        getConnection: () =>
          Promise.resolve({
            execute,
            beginTransaction: () => Promise.resolve(),
            commit: () => Promise.resolve(),
            rollback: () => Promise.resolve(),
            release: () => undefined,
          }),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) => {
          const userId = liveTokens.get(hashOpaqueToken(token));
          if (token === 'banned-token') {
            return Promise.resolve({
              kind: 'restricted',
              userId: 'ben',
              restriction: { type: 'ban', expires_at: null },
            });
          }
          return Promise.resolve(
            userId
              ? { kind: 'valid', emailVerified: true, userId }
              : { kind: 'invalid' },
          );
        },
      })
      .overrideProvider(PUSH_CONFIG)
      .useValue({
        vapid: { ...generateVapidKeys(), subject: 'mailto:ops@example.org' },
        allowedHosts: DEFAULT_PUSH_ALLOWED_HOSTS,
        ttlSeconds: 86400,
        dispatchIntervalSeconds: 5,
        batchSize: 200,
        maxAgeSeconds: 3600,
        maxFailures: 5,
        perAccount: 10,
      })
      .overrideProvider(PUSH_TRANSPORT)
      .useValue({
        send: (push: PushRequest) => {
          pushes.push(push);
          return Promise.resolve({ status: pushStatus });
        },
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as unknown as Server).address() as AddressInfo)
      .port;
  });

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await app.close();
    delete process.env.PUSH_DISPATCH_DISABLED;
  });

  const open = (path: string, token?: string): Promise<Stream> =>
    new Promise((resolve, reject) => {
      const req = get(
        {
          host: '127.0.0.1',
          port,
          path,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
        (response) => {
          let done: () => void = () => undefined;
          const stream: Stream = {
            status: response.statusCode ?? 0,
            headers: response.headers,
            events: [],
            raw: '',
            closed: new Promise((end) => (done = end)),
            close: () => req.destroy(),
          };
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            stream.raw += chunk;
            stream.events = stream.raw
              .split('\n\n')
              .filter((block) => block.includes('event: '))
              .map((block) => [
                /event: (.+)/.exec(block)![1],
                JSON.parse(/data: (.+)/.exec(block)![1]) as unknown,
              ]);
          });
          response.on('end', done);
          response.on('close', done);
          streams.push(stream);
          // Resolve once the first event (or an error body) arrived.
          const ready = () => resolve(stream);
          if (response.statusCode !== 200) {
            response.on('end', ready);
          } else {
            response.once('data', () => setTimeout(ready, 20));
          }
        },
      );
      req.on('error', reject);
    });
  const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const as = (token: string) => {
    const auth = { Authorization: `Bearer ${token}` };
    const server = app.getHttpServer();
    return {
      get: (path: string) => request(server).get(path).set(auth),
      post: (path: string) => request(server).post(path).set(auth),
      delete: (path: string) => request(server).delete(path).set(auth),
    };
  };

  describe('GET /notifications/stream', () => {
    it('streams only the caller’s new notifications, unbuffered, after the unread count', async () => {
      const sam = await open('/notifications/stream', 'sam-token');
      const alex = await open('/notifications/stream', 'alex-token');
      expect(sam.status).toBe(200);
      expect(sam.headers['content-type']).toBe(
        'text/event-stream; charset=utf-8',
      );
      expect(sam.headers['x-accel-buffering']).toBe('no');
      expect(sam.headers['cache-control']).toBe('no-cache, no-transform');
      expect(sam.events).toEqual([['unread-count', { unread: 1 }]]);

      notes.push(note('n-new', 'sam'));
      await app.get(NotificationStreamService).poll();
      await until(() => sam.events.length >= 3);

      expect(sam.events.slice(1)).toEqual([
        [
          'notification',
          expect.objectContaining({
            id: 'n-new',
            type: 'post_comment',
            actor_username: 'alex',
          }),
        ],
        ['unread-count', { unread: 2 }],
      ]);
      expect(sam.events.map(([, data]) => data)).not.toContainEqual(
        expect.objectContaining({ id: 'n-old' }),
      );
      expect(alex.events).toEqual([['unread-count', { unread: 0 }]]);
    });

    it('sends heartbeats that keep proxies from closing it', async () => {
      const sam = await open('/notifications/stream', 'sam-token');
      app.get(NotificationStreamService).heartbeat();
      await until(() => sam.raw.includes(': ping'));
      expect(sam.raw).toContain(': ping\n\n');
      expect(sam.raw.startsWith('retry: 5000\n\n')).toBe(true);
    });

    it('is refused without a valid token, and to a banned account', async () => {
      expect((await open('/notifications/stream')).status).toBe(401);
      expect((await open('/notifications/stream', 'nobody-token')).status).toBe(
        401,
      );
      expect((await open('/notifications/stream', 'banned-token')).status).toBe(
        403,
      );
    });

    it('ends when its session ends', async () => {
      const sam = await open('/notifications/stream', 'sam-token');
      liveTokens.delete(hashOpaqueToken('sam-token'));
      app.get(SessionEvents).announce('sam');
      await sam.closed;
      expect(sam.events.at(-1)).toEqual(['end', { reason: 'session_ended' }]);
    });

    it('accepts a single-use ticket instead of the header, for EventSource', async () => {
      const minted = await as('sam-token')
        .post('/notifications/stream-tickets')
        .expect(201);
      const { ticket } = minted.body as { ticket: string; expires_in: number };
      expect(minted.body).toMatchObject({ expires_in: 60 });
      expect(tickets.has(hashOpaqueToken(ticket))).toBe(true);

      const stream = await open(`/notifications/stream?ticket=${ticket}`);
      expect(stream.status).toBe(200);
      expect(stream.events).toEqual([['unread-count', { unread: 1 }]]);
      expect(
        (await open(`/notifications/stream?ticket=${ticket}`)).status,
      ).toBe(401);
      await request(app.getHttpServer())
        .post('/notifications/stream-tickets')
        .expect(401);
    });
  });

  describe('DELETE /notifications', () => {
    it('deletes the caller’s notifications only, idempotently', async () => {
      notes.push(note('n-alex', 'alex'));
      await as('sam-token')
        .delete('/notifications')
        .expect(200, { deleted: 1 });
      await as('sam-token')
        .delete('/notifications')
        .expect(200, { deleted: 0 });
      expect(notes.map((n) => n.id)).toEqual(['n-alex']);
      await as('sam-token').delete('/notifications?read=true').expect(400);
    });

    it('sends open streams the new unread count', async () => {
      const sam = await open('/notifications/stream', 'sam-token');
      await as('sam-token').delete('/notifications').expect(200);
      await until(() => sam.events.length >= 2);
      expect(sam.events.at(-1)).toEqual(['unread-count', { unread: 0 }]);
    });
  });

  describe('push subscriptions', () => {
    const subscription = {
      endpoint: ENDPOINT,
      keys: { p256dh: UA_PUBLIC, auth: AUTH },
    };

    it('registers, lists by origin and deletes the caller’s subscriptions', async () => {
      const created = await as('sam-token')
        .post('/users/me/push-subscriptions')
        .send(subscription)
        .expect(201);
      expect(created.body).toMatchObject({
        endpoint_origin: 'https://fcm.googleapis.com',
      });
      expect(JSON.stringify(created.body)).not.toContain('sam-browser');

      const listed = await as('sam-token')
        .get('/users/me/push-subscriptions')
        .expect(200);
      expect(listed.body).toMatchObject({
        enabled: true,
        public_key: expect.any(String),
        items: [{ id: (created.body as { id: string }).id }],
      });
      expect(
        (await as('alex-token').get('/users/me/push-subscriptions').expect(200))
          .body,
      ).toMatchObject({ items: [] });

      const id = (created.body as { id: string }).id;
      await as('alex-token')
        .delete(`/users/me/push-subscriptions/${id}`)
        .expect(404);
      await as('sam-token')
        .delete(`/users/me/push-subscriptions/${id}`)
        .expect(204);
      expect(subscriptions.size).toBe(0);
    });

    it('refuses endpoints outside the push services', async () => {
      await as('sam-token')
        .post('/users/me/push-subscriptions')
        .send({ ...subscription, endpoint: 'https://internal.example/hook' })
        .expect(400);
      await as('sam-token')
        .post('/users/me/push-subscriptions')
        .send({ ...subscription, keys: { p256dh: UA_PUBLIC } })
        .expect(400);
    });

    it('pushes new notifications encrypted, and drops a subscription the service reports gone', async () => {
      await as('sam-token')
        .post('/users/me/push-subscriptions')
        .send(subscription)
        .expect(201);
      notes.push(note('n-push', 'sam'));
      const dispatcher = app.get(PushDispatcherService);

      await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
        sent: 2,
      });
      expect(pushes[0]).toMatchObject({
        endpoint: ENDPOINT,
        headers: { 'Content-Encoding': 'aes128gcm', TTL: '86400' },
      });
      expect(pushes[0].body.toString('utf8')).not.toContain('Seeds');
      // Each notification is pushed once.
      await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
        claimed: 0,
      });

      pushStatus = 410;
      notes.push(note('n-gone', 'sam'));
      await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
        removed: 1,
      });
      expect(subscriptions.size).toBe(0);
    });
  });
});
