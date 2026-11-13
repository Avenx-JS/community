import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Pool } from 'mysql2/promise';
import { Subject } from 'rxjs';
import { hashOpaqueToken } from '../auth/auth.service';
import type { SessionEvents } from '../auth/session-events';
import type { NotificationInboxService } from './notification-inbox.service';
import { UNREAD_COUNT_SQL } from './notification-inbox.service';
import {
  INSERT_STREAM_TICKET_SQL,
  liveStreamSessionsSql,
  NotificationStreamService,
  recentNotificationsSql,
  STREAM_TICKET_SQL,
  USE_STREAM_TICKET_SQL,
} from './notification-stream.service';
import {
  DEFAULT_PUSH_ALLOWED_HOSTS,
  isAllowedPushEndpoint,
  readPushConfig,
  type PushConfig,
  type PushRequest,
} from './web-push/push-config';
import {
  CLAIM_PUSH_SQL,
  markDispatchedSql,
  PUSH_FAILED_SQL,
  PUSH_GIVE_UP_SQL,
  PUSH_GONE_SQL,
  PUSH_SUCCEEDED_SQL,
  PushDispatcherService,
  subscriptionsOfSql,
  expiredSubscriptionsSql,
} from './web-push/push-dispatcher.service';
import {
  COUNT_SUBSCRIPTIONS_SQL,
  DELETE_SUBSCRIPTION_SQL,
  PushSubscriptionsService,
  SUBSCRIPTION_BY_ENDPOINT_SQL,
  UPSERT_SUBSCRIPTION_SQL,
} from './web-push/push-subscriptions.service';
import { generateVapidKeys } from './web-push/web-push-crypto';

// RFC 8291 Appendix A's browser keys: a valid subscription.
const UA_PUBLIC =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

type Answer = unknown[] | { affectedRows: number };

function database() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const answers = new Map<string, Answer>();
  const execute = (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    return Promise.resolve([answers.get(sql) ?? [], []]);
  };
  const connection = {
    execute,
    beginTransaction: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
    release: () => undefined,
  };
  const pool = {
    execute,
    getConnection: () => Promise.resolve(connection),
  } as unknown as Pool;
  return { pool, statements, answers };
}

const config = (overrides: Partial<PushConfig> = {}): PushConfig => ({
  vapid: { ...generateVapidKeys(), subject: 'mailto:ops@example.org' },
  allowedHosts: DEFAULT_PUSH_ALLOWED_HOSTS,
  ttlSeconds: 86400,
  dispatchIntervalSeconds: 5,
  batchSize: 200,
  maxAgeSeconds: 3600,
  maxFailures: 5,
  perAccount: 10,
  ...overrides,
});

describe('push configuration', () => {
  it('is off without VAPID keys, and refuses a partial or malformed set', () => {
    expect(readPushConfig({}).vapid).toBeNull();
    expect(() => readPushConfig({ VAPID_PUBLIC_KEY: UA_PUBLIC })).toThrow(
      /must be set together/,
    );
    const keys = generateVapidKeys();
    expect(() =>
      readPushConfig({
        VAPID_PUBLIC_KEY: keys.publicKey,
        VAPID_PRIVATE_KEY: keys.privateKey,
        VAPID_SUBJECT: 'ops@example.org',
      }),
    ).toThrow(/mailto: or https:/);
    expect(
      readPushConfig({
        VAPID_PUBLIC_KEY: keys.publicKey,
        VAPID_PRIVATE_KEY: keys.privateKey,
        VAPID_SUBJECT: 'mailto:ops@example.org',
      }).vapid,
    ).toMatchObject({ publicKey: keys.publicKey });
  });

  // The server POSTs to endpoints, which clients supply: only known push
  // services, so it cannot be pointed anywhere else.
  it.each([
    [ENDPOINT, true],
    ['https://updates.push.services.mozilla.com/wpush/v2/x', true],
    ['https://db5p.notify.windows.com/w/?token=x', true],
    ['https://web.push.apple.com/abc', true],
    ['http://fcm.googleapis.com/fcm/send/abc', false],
    ['https://fcm.googleapis.com:8443/x', false],
    ['https://user:pw@fcm.googleapis.com/x', false],
    ['https://fcm.googleapis.com.evil.example/x', false],
    ['https://evilfcm.googleapis.com.example/x', false],
    ['https://127.0.0.1/x', false],
    ['https://localhost/x', false],
    ['not a url', false],
  ])('allows %s: %s', (endpoint, allowed) => {
    expect(isAllowedPushEndpoint(endpoint, DEFAULT_PUSH_ALLOWED_HOSTS)).toBe(
      allowed,
    );
  });
});

describe('PushSubscriptionsService', () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    endpoint: ENDPOINT,
    keys: { p256dh: UA_PUBLIC, auth: AUTH },
    ...overrides,
  });

  it('stores a valid subscription once per endpoint and returns only its origin', async () => {
    const db = database();
    db.answers.set(COUNT_SUBSCRIPTIONS_SQL, [{ total: 0 }]);
    db.answers.set(SUBSCRIPTION_BY_ENDPOINT_SQL, [
      {
        id: 's-1',
        endpoint: ENDPOINT,
        user_agent: 'Firefox',
        created_at: new Date('2026-11-13T10:00:00Z'),
        last_success_at: null,
        expires_at: null,
      },
    ]);
    const service = new PushSubscriptionsService(db.pool, config());
    await expect(service.register('sam', input(), 'Firefox')).resolves.toEqual({
      id: 's-1',
      endpoint_origin: 'https://fcm.googleapis.com',
      user_agent: 'Firefox',
      created_at: '2026-11-13T10:00:00.000Z',
      last_success_at: null,
      expires_at: null,
    });
    const upsert = db.statements.find(
      ({ sql }) => sql === UPSERT_SUBSCRIPTION_SQL,
    );
    expect(upsert?.values.slice(1)).toEqual([
      'sam',
      ENDPOINT,
      expect.stringMatching(/^[0-9a-f]{64}$/),
      UA_PUBLIC,
      AUTH,
      null,
      'Firefox',
    ]);
  });

  it.each([
    [
      'an endpoint outside the push services',
      { endpoint: 'https://example.com/x' },
    ],
    ['a key off the curve', { keys: { p256dh: 'BAAA', auth: AUTH } }],
    ['a short auth secret', { keys: { p256dh: UA_PUBLIC, auth: 'AAAA' } }],
    ['an expired subscription', { expirationTime: Date.now() - 1000 }],
  ])('refuses %s', async (_case, overrides) => {
    const db = database();
    await expect(
      new PushSubscriptionsService(db.pool, config()).register(
        'sam',
        input(overrides) as never,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.statements).toEqual([]);
  });

  it('caps subscriptions per account, and is unavailable without VAPID keys', async () => {
    const db = database();
    db.answers.set(COUNT_SUBSCRIPTIONS_SQL, [{ total: 10 }]);
    await expect(
      new PushSubscriptionsService(db.pool, config()).register(
        'sam',
        input(),
        undefined,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      new PushSubscriptionsService(db.pool, config({ vapid: null })).register(
        'sam',
        input(),
        undefined,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lists with the public key, and deletes only the caller’s', async () => {
    const db = database();
    const settings = config();
    db.answers.set(DELETE_SUBSCRIPTION_SQL, { affectedRows: 0 });
    const service = new PushSubscriptionsService(db.pool, settings);
    await expect(service.list('sam')).resolves.toEqual({
      enabled: true,
      public_key: settings.vapid!.publicKey,
      items: [],
    });
    await expect(service.remove('sam', 's-9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(db.statements.at(-1)).toEqual({
      sql: DELETE_SUBSCRIPTION_SQL,
      values: ['s-9', 'sam'],
    });
  });
});

describe('PushDispatcherService', () => {
  const claimed = (overrides: Record<string, unknown> = {}) => ({
    id: 'n-1',
    recipient_id: 'sam',
    type: 'post_comment',
    subject_type: 'comment',
    subject_id: 'c-1',
    community_id: 'k-1',
    metadata: JSON.stringify({ post_title: 'Seeds', actor_username: 'alex' }),
    read_at: null,
    created_at: new Date('2026-11-13T10:00:00Z'),
    deliver: 1,
    ...overrides,
  });
  const subscription = {
    id: 's-1',
    user_id: 'sam',
    endpoint: ENDPOINT,
    p256dh: UA_PUBLIC,
    auth: AUTH,
  };

  function harness(status: number) {
    const db = database();
    const sent: PushRequest[] = [];
    const service = new PushDispatcherService(db.pool, config(), {
      send: (request) => {
        sent.push(request);
        return Promise.resolve({ status });
      },
    });
    db.answers.set(CLAIM_PUSH_SQL, [
      claimed(),
      claimed({ id: 'n-2', deliver: 0 }),
    ]);
    db.answers.set(subscriptionsOfSql(1), [subscription]);
    db.answers.set(expiredSubscriptionsSql(1), { affectedRows: 0 });
    return { db, sent, service };
  }

  it('claims a batch once, and pushes only what the preferences allow', async () => {
    const { db, sent, service } = harness(201);
    await expect(service.dispatchOnce()).resolves.toEqual({
      claimed: 2,
      sent: 1,
      removed: 0,
    });

    expect(db.statements[0]).toEqual({
      sql: CLAIM_PUSH_SQL,
      values: [3600, 200],
    });
    expect(db.statements[1]).toEqual({
      sql: markDispatchedSql(2),
      values: ['n-1', 'n-2'],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe(ENDPOINT);
    expect(sent[0].headers).toMatchObject({
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Authorization: expect.stringMatching(
        /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/,
      ),
    });
    // salt, record size 4096, a 65-byte key, then the encrypted record.
    expect(sent[0].body.readUInt32BE(16)).toBe(4096);
    expect(sent[0].body[20]).toBe(65);
    expect(db.statements.map(({ sql }) => sql)).toContain(PUSH_SUCCEEDED_SQL);
  });

  // The preferences are evaluated in the claim, read when it is pushed.
  it('reads every preference and the block filter in the claim', () => {
    for (const fragment of [
      'COALESCE(preferences.push_notifications, TRUE)',
      "(n.type <> 'community_post' OR COALESCE(membership.new_posts, TRUE))",
      'FROM user_blocks',
      'n.created_at >= UTC_TIMESTAMP() - INTERVAL ? SECOND',
      'WHERE n.push_dispatched_at IS NULL',
      'FOR UPDATE OF n SKIP LOCKED',
    ]) {
      expect(CLAIM_PUSH_SQL).toContain(fragment);
    }
  });

  it.each([404, 410])(
    'removes a subscription the push service reports gone (%i)',
    async (status) => {
      const { db, service } = harness(status);
      await expect(service.dispatchOnce()).resolves.toMatchObject({
        removed: 1,
      });
      expect(db.statements.at(-1)).toEqual({
        sql: PUSH_GONE_SQL,
        values: ['s-1'],
      });
    },
  );

  it('counts other failures, and gives up after PUSH_MAX_FAILURES', async () => {
    const { db, service } = harness(503);
    db.answers.set(PUSH_GIVE_UP_SQL, { affectedRows: 0 });
    await expect(service.dispatchOnce()).resolves.toMatchObject({
      sent: 0,
      removed: 0,
    });
    expect(db.statements.slice(-2)).toEqual([
      { sql: PUSH_FAILED_SQL, values: ['s-1'] },
      { sql: PUSH_GIVE_UP_SQL, values: ['s-1', 5] },
    ]);
    db.answers.set(PUSH_GIVE_UP_SQL, { affectedRows: 1 });
    db.answers.set(CLAIM_PUSH_SQL, [claimed()]);
    await expect(service.dispatchOnce()).resolves.toMatchObject({ removed: 1 });
  });

  it('does nothing without VAPID keys', async () => {
    const db = database();
    const service = new PushDispatcherService(
      db.pool,
      config({ vapid: null }),
      {
        send: () => Promise.reject(new Error('never')),
      },
    );
    await expect(service.dispatchOnce()).resolves.toEqual({
      claimed: 0,
      sent: 0,
      removed: 0,
    });
    expect(db.statements).toEqual([]);
  });
});

describe('NotificationStreamService', () => {
  const row = (id: string, recipient = 'sam') => ({
    id,
    recipient_id: recipient,
    type: 'post_comment',
    subject_type: 'comment',
    subject_id: 'c-1',
    community_id: null,
    metadata: null,
    read_at: null,
    created_at: new Date('2026-11-13T10:00:00Z'),
  });

  function fakeResponse() {
    const written: string[] = [];
    const listeners: Record<string, () => void> = {};
    const response = {
      headers: {} as Record<string, string>,
      writableEnded: false,
      destroyed: false,
      socket: null,
      status: () => response,
      setHeader: (name: string, value: string) => {
        response.headers[name] = value;
      },
      flushHeaders: () => undefined,
      write: (text: string) => {
        written.push(text);
        return true;
      },
      end: () => {
        response.writableEnded = true;
        listeners.close?.();
      },
      on: (event: string, listener: () => void) => {
        listeners[event] = listener;
      },
    };
    const events = () =>
      written
        .filter((text) => text.includes('event: '))
        .map((text) => {
          const name = /event: (.+)\n/.exec(text)![1];
          return [name, JSON.parse(/data: (.+)\n/.exec(text)![1]) as unknown];
        });
    return { response, written, events, close: () => listeners.close?.() };
  }

  let db: ReturnType<typeof database>;
  let sessionsChanged: Subject<string>;
  let unreadChanged: Subject<string>;
  let service: NotificationStreamService;

  beforeEach(() => {
    db = database();
    sessionsChanged = new Subject();
    unreadChanged = new Subject();
    db.answers.set(UNREAD_COUNT_SQL, [{ unread: 2 }]);
    service = new NotificationStreamService(
      db.pool,
      { changed: sessionsChanged } as unknown as SessionEvents,
      { unreadChanged } as unknown as NotificationInboxService,
    );
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  const open = async (userId = 'sam', token = 'hash-1') => {
    const stream = fakeResponse();
    await service.open(
      { userId, tokenHash: token },
      stream.response as unknown as Response,
    );
    return stream;
  };

  it('opens an unbuffered event stream and sends the unread count', async () => {
    const stream = await open();
    expect(stream.response.headers).toEqual({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    expect(stream.written[0]).toBe('retry: 5000\n\n');
    expect(stream.events()).toEqual([['unread-count', { unread: 2 }]]);
    expect(db.statements[0]).toEqual({
      sql: recentNotificationsSql(1),
      values: ['sam', 60],
    });
  });

  it('sends new notifications once, only to their recipient, then the new count', async () => {
    db.answers.set(recentNotificationsSql(1), [row('old')]);
    const sam = await open('sam');
    db.answers.set(recentNotificationsSql(1), []);
    const alex = await open('alex', 'hash-2');

    db.answers.set(recentNotificationsSql(2), [row('old'), row('new')]);
    await service.poll();
    await service.poll();

    expect(sam.events().map(([name]) => name)).toEqual([
      'unread-count',
      'notification',
      'unread-count',
    ]);
    expect(sam.events()[1][1]).toMatchObject({
      id: 'new',
      type: 'post_comment',
    });
    expect(
      sam.written.find((text) => text.startsWith('id: new\n')),
    ).toBeDefined();
    expect(alex.events().map(([name]) => name)).toEqual(['unread-count']);
  });

  it('reads only the recipients’ notifications, with the inbox’s block filter', () => {
    expect(recentNotificationsSql(2)).toContain('n.recipient_id IN (?, ?)');
    expect(recentNotificationsSql(2)).toContain('FROM user_blocks');
  });

  it('ends streams whose session ended, at once on this instance', async () => {
    const stream = await open('sam', 'hash-1');
    db.answers.set(liveStreamSessionsSql(1), []);
    sessionsChanged.next('sam');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.events().at(-1)).toEqual([
      'end',
      { reason: 'session_ended' },
    ]);
    expect(stream.response.writableEnded).toBe(true);
    expect(service.size).toBe(0);
  });

  it('keeps streams whose session is live', async () => {
    const stream = await open('sam', 'hash-1');
    db.answers.set(liveStreamSessionsSql(1), [
      { token_hash: 'hash-1', user_id: 'sam' },
    ]);
    await service.revalidate();
    expect(stream.response.writableEnded).toBe(false);
    for (const fragment of [
      's.expires_at > UTC_TIMESTAMP()',
      'u.deleted_at IS NULL',
      'FROM user_restrictions',
    ]) {
      expect(liveStreamSessionsSql(1)).toContain(fragment);
    }
  });

  it('lets the oldest stream give way beyond the per-account limit', async () => {
    const streams: Awaited<ReturnType<typeof open>>[] = [];
    for (let index = 0; index <= service.perAccount; index += 1) {
      streams.push(await open('sam', `hash-${index}`));
    }
    expect(streams[0].events().at(-1)).toEqual(['end', { reason: 'replaced' }]);
    expect(service.size).toBe(service.perAccount);
  });

  it('pushes a new unread count after a change in the inbox', async () => {
    const stream = await open();
    unreadChanged.next('sam');
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.events()).toHaveLength(2);
  });

  it('forgets a client that disconnected', async () => {
    const stream = await open();
    stream.close();
    expect(service.size).toBe(0);
  });

  it('mints single-use tickets bound to the session, stored only as hashes', async () => {
    const { ticket, expires_in } = await service.mintTicket(
      'sam',
      'access-token',
    );
    expect(expires_in).toBe(60);
    expect(db.statements[0]).toEqual({
      sql: INSERT_STREAM_TICKET_SQL,
      values: [
        hashOpaqueToken(ticket),
        'sam',
        hashOpaqueToken('access-token'),
        60,
      ],
    });
    expect(JSON.stringify(db.statements)).not.toContain(ticket);

    db.answers.set(USE_STREAM_TICKET_SQL, { affectedRows: 1 });
    db.answers.set(STREAM_TICKET_SQL, [
      { user_id: 'sam', token_hash: 'hash-1' },
    ]);
    db.answers.set(liveStreamSessionsSql(1), [
      { token_hash: 'hash-1', user_id: 'sam' },
    ]);
    await expect(service.redeemTicket(ticket)).resolves.toEqual({
      userId: 'sam',
      tokenHash: 'hash-1',
    });

    db.answers.set(USE_STREAM_TICKET_SQL, { affectedRows: 0 });
    await expect(service.redeemTicket(ticket)).resolves.toBeNull();
    expect(USE_STREAM_TICKET_SQL).toContain(
      'used_at IS NULL AND expires_at > UTC_TIMESTAMP()',
    );
  });

  it('refuses a ticket whose session ended', async () => {
    db.answers.set(USE_STREAM_TICKET_SQL, { affectedRows: 1 });
    db.answers.set(STREAM_TICKET_SQL, [
      { user_id: 'sam', token_hash: 'hash-1' },
    ]);
    await expect(service.redeemTicket('t')).resolves.toBeNull();
  });

  it('closes every stream on shutdown', async () => {
    const stream = await open();
    const spy = jest.spyOn(stream.response, 'end');
    service.onModuleDestroy();
    expect(spy).toHaveBeenCalled();
    expect(stream.events().at(-1)).toEqual(['end', { reason: 'shutdown' }]);
  });
});
