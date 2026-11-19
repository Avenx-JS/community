import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { AuthService, MYSQL_POOL } from '../src/auth/auth.service';
import { ACTIVE_COMMUNITY_BAN_SQL } from '../src/common/active-community-ban';
import { SafeApiExceptionFilter } from '../src/common/safe-api-exception.filter';
import { COMMUNITY_ROLE_BY_NAME_SQL } from '../src/communities/community-access';
import {
  COMMUNITY_AVAILABLE_SQL,
  INSERT_MESSAGE_SQL,
  INSERT_THREAD_SQL,
  LOCK_THREAD_SQL,
  LOCK_USER_SQL,
  MODMAIL_USER_SQL,
  RECENT_USER_THREADS_SQL,
  SET_STATUS_SQL,
  TEAM_RECIPIENTS_SQL,
  THREAD_BY_ID_SQL,
  THREAD_MESSAGES_SQL,
  TOUCH_THREAD_SQL,
} from '../src/modmail/modmail.service';

interface Thread {
  id: string;
  community_id: string;
  user_id: string;
  subject: string;
  status: string;
  started_by: string;
  created_at: Date;
}

// The modmail routes through the real controllers and service, over an
// in-memory store: an appeal by a banned user, the team's reply, archiving,
// and who may call what.
describe('Modmail (e2e)', () => {
  let app: INestApplication<App>;
  const usernames: Record<string, string> = {
    'u-creator': 'founder',
    'u-mod': 'mod_jane',
    'u-appellant': 'appellant',
    'u-restricted': 'restricted_user',
    'u-other': 'other_user',
  };
  const team = new Set(['u-creator', 'u-mod']);
  let threads: Map<string, Thread>;
  let messages: Array<Record<string, unknown>>;
  let notifications: unknown[][];
  let bannedUsers: Set<string>;

  beforeEach(async () => {
    threads = new Map();
    messages = [];
    notifications = [];
    bannedUsers = new Set(['u-appellant']);
    const result = (rows: unknown) => Promise.resolve([rows, []]);
    const threadRow = (t: Thread) => ({
      ...t,
      community_name: 'garden',
      username: usernames[t.user_id],
      last_message_at: t.created_at,
    });
    const run = (sql: string, values: unknown[] = []) => {
      const [first, second] = values as string[];
      if (sql === COMMUNITY_ROLE_BY_NAME_SQL) {
        return result(
          values[2] === 'garden'
            ? [
                {
                  id: 'k-1',
                  name: 'garden',
                  creator_id: 'u-creator',
                  visibility: 'public',
                  can_moderate: team.has(first) ? 1 : 0,
                },
              ]
            : [],
        );
      }
      if (sql === LOCK_USER_SQL) return result([{ id: first }]);
      if (sql === ACTIVE_COMMUNITY_BAN_SQL) {
        return result(bannedUsers.has(second) ? [{ id: 'b' }] : []);
      }
      if (sql === RECENT_USER_THREADS_SQL) {
        const recent = [...threads.values()].filter(
          (t) =>
            t.user_id === first &&
            t.community_id === second &&
            t.started_by === 'user',
        );
        return result([{ total: recent.length, retry_after: 86000 }]);
      }
      if (sql === MODMAIL_USER_SQL) {
        const id = Object.keys(usernames).find((k) => usernames[k] === first);
        return result(id ? [{ id, username: first }] : []);
      }
      if (sql === THREAD_BY_ID_SQL || sql === LOCK_THREAD_SQL) {
        const t = threads.get(first);
        return result(t ? [threadRow(t)] : []);
      }
      if (sql === THREAD_MESSAGES_SQL) {
        return result(
          messages
            .filter((m) => m.thread_id === first)
            .map((m) => ({
              ...m,
              author_username: usernames[m.author_id as string],
              created_at: new Date('2026-11-19T10:00:00Z'),
            })),
        );
      }
      if (sql === TEAM_RECIPIENTS_SQL) {
        return result([...team].map((id) => ({ id })));
      }
      if (sql === COMMUNITY_AVAILABLE_SQL) return result([{ available: 1 }]);
      if (sql === INSERT_THREAD_SQL) {
        const [id, community, user, subject, startedBy] = values as string[];
        threads.set(id, {
          id,
          community_id: community,
          user_id: user,
          subject,
          status: 'open',
          started_by: startedBy,
          created_at: new Date('2026-11-19T10:00:00Z'),
        });
        return result({ affectedRows: 1 });
      }
      if (sql === INSERT_MESSAGE_SQL) {
        const [id, thread, author, body, isModerator] = values as [
          string,
          string,
          string,
          string,
          boolean,
        ];
        messages.push({
          id,
          thread_id: thread,
          author_id: author,
          body,
          is_moderator: isModerator ? 1 : 0,
        });
        return result({ affectedRows: 1 });
      }
      if (sql === TOUCH_THREAD_SQL || sql === SET_STATUS_SQL) {
        threads.get(values[1] as string)!.status = values[0] as string;
        return result({ affectedRows: 1 });
      }
      if (sql.startsWith('INSERT INTO notifications')) {
        // One multi-row INSERT: eight values a row.
        for (let at = 0; at < values.length; at += 8) {
          notifications.push(values.slice(at, at + 8));
        }
        return result({ affectedRows: 1 });
      }
      // The lists.
      if (sql.includes('FROM modmail_threads t') && sql.includes('LIMIT ?')) {
        const own = sql.includes('t.user_id = ?');
        const rows = [...threads.values()].filter((t) =>
          own
            ? t.user_id === first
            : t.community_id === first && t.status === second,
        );
        return result(rows.map(threadRow));
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM modmail_threads t')) {
        const own = sql.includes('t.user_id = ?');
        return result([
          {
            total: [...threads.values()].filter((t) =>
              own
                ? t.user_id === first
                : t.community_id === first && t.status === second,
            ).length,
          },
        ]);
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    };

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MYSQL_POOL)
      .useValue({
        execute: run,
        getConnection: () =>
          Promise.resolve({
            beginTransaction: () => Promise.resolve(),
            commit: () => Promise.resolve(),
            rollback: () => Promise.resolve(),
            release: () => undefined,
            execute: run,
          }),
      })
      .overrideProvider(AuthRateLimitService)
      .useValue({ enforceApiRequest: () => Promise.resolve(null) })
      .overrideProvider(AuthService)
      .useValue({
        validateAccessTokenState: (token: string) => {
          const id = Object.keys(usernames).find(
            (key) => `${usernames[key]}-token` === token,
          );
          if (!id) return Promise.resolve({ kind: 'invalid' });
          return Promise.resolve(
            id === 'u-restricted'
              ? {
                  kind: 'restricted',
                  userId: id,
                  restriction: { type: 'ban', expires_at: null },
                }
              : { kind: 'valid', emailVerified: true, userId: id },
          );
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
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const as = (username: string | null) => {
    const auth = (test: request.Test) =>
      username === null
        ? test
        : test.set('Authorization', `Bearer ${username}-token`);
    const server = () => request(app.getHttpServer());
    return {
      get: (path: string) => auth(server().get(path)),
      post: (path: string, body: object = {}) =>
        auth(server().post(path)).send(body),
    };
  };
  const appeal = {
    subject: 'About my ban',
    body: 'I think this was a mistake.',
  };

  it('lets a banned user appeal; the team reads, replies anonymously, and archives', async () => {
    const opened = await as('appellant')
      .post('/communities/garden/modmail', appeal)
      .expect(201);
    const threadId = (opened.body as { id: string }).id;
    expect(opened.body).toMatchObject({ started_by: 'user', status: 'open' });
    // Both team members are told, the user named in from_username, no actor.
    expect(notifications.map((row) => [row[1], row[2], row[3]])).toEqual([
      ['u-creator', 'modmail_message', null],
      ['u-mod', 'modmail_message', null],
    ]);

    const listed = await as('mod_jane')
      .get('/communities/garden/modmail')
      .expect(200);
    expect(listed.body).toMatchObject({
      total: 1,
      items: [{ id: threadId, username: 'appellant' }],
    });

    await as('mod_jane')
      .post(`/communities/garden/modmail/${threadId}/messages`, {
        body: 'We will look into it.',
      })
      .expect(201);
    const own = await as('appellant')
      .get(`/users/me/modmail/${threadId}`)
      .expect(200);
    expect((own.body as { messages: unknown[] }).messages[1]).toMatchObject({
      is_moderator: true,
      author_label: 'moderators of c/garden',
      author_username: null,
    });
    expect(JSON.stringify(own.body)).not.toContain('mod_jane');
    const teamView = await as('founder')
      .get(`/communities/garden/modmail/${threadId}`)
      .expect(200);
    expect(
      (teamView.body as { messages: unknown[] }).messages[1],
    ).toMatchObject({
      author_username: 'mod_jane',
    });

    await as('founder')
      .post(`/communities/garden/modmail/${threadId}/archive`)
      .expect(200);
    await as('mod_jane')
      .get('/communities/garden/modmail?status=archived')
      .expect(200)
      .expect((res) => expect((res.body as { total: number }).total).toBe(1));
    // The user's reply reopens it.
    await as('appellant')
      .post(`/users/me/modmail/${threadId}/messages`, { body: 'Any news?' })
      .expect(201)
      .expect((res) =>
        expect((res.body as { status: string }).status).toBe('open'),
      );

    // A banned user: one new thread a day.
    const limited = await as('appellant')
      .post('/communities/garden/modmail', appeal)
      .expect(429);
    expect(limited.body).toMatchObject({ retry_after_seconds: 86000 });
  });

  it('lets the team start a thread with any user', async () => {
    const opened = await as('mod_jane')
      .post('/communities/garden/modmail', {
        ...appeal,
        subject: 'A warning',
        username: 'other_user',
      })
      .expect(201);
    expect(opened.body).toMatchObject({
      started_by: 'moderators',
      username: 'other_user',
    });
    expect(notifications.map((row) => row[1])).toEqual(['u-other']);
    await as('other_user')
      .get('/users/me/modmail')
      .expect(200)
      .expect((res) => expect((res.body as { total: number }).total).toBe(1));
  });

  it('keeps the team routes to the team, and threads to their user', async () => {
    const opened = await as('appellant')
      .post('/communities/garden/modmail', appeal)
      .expect(201);
    const threadId = (opened.body as { id: string }).id;
    await as('other_user').get('/communities/garden/modmail').expect(403);
    await as('other_user')
      .get(`/communities/garden/modmail/${threadId}`)
      .expect(403);
    await as('other_user')
      .post('/communities/garden/modmail', { ...appeal, username: 'appellant' })
      .expect(403);
    await as('other_user').get(`/users/me/modmail/${threadId}`).expect(404);
    await as('mod_jane')
      .post('/communities/garden/modmail', appeal)
      .expect(409);
    await as(null).get('/users/me/modmail').expect(401);
    await as('appellant').get('/communities/nope/modmail').expect(404);
  });

  // Restricted: may read and answer existing threads, not open new ones.
  it('lets a platform-restricted user reply, but not start a thread', async () => {
    const opened = await as('mod_jane')
      .post('/communities/garden/modmail', {
        ...appeal,
        username: 'restricted_user',
      })
      .expect(201);
    const threadId = (opened.body as { id: string }).id;
    await as('restricted_user').get('/users/me/modmail').expect(200);
    await as('restricted_user')
      .get(`/users/me/modmail/${threadId}`)
      .expect(200);
    await as('restricted_user')
      .post(`/users/me/modmail/${threadId}/messages`, {
        body: 'Please reconsider.',
      })
      .expect(201);
    await as('restricted_user')
      .post('/communities/garden/modmail', appeal)
      .expect(403);
  });

  it.each([
    [{ body: 'no subject' }],
    [{ subject: '', body: 'x' }],
    [{ subject: 's', body: '' }],
    [{ subject: 's', body: 'x'.repeat(10001) }],
    [{ subject: 'x'.repeat(201), body: 'b' }],
    [{ subject: 's', body: 'bad \u0000 byte' }],
    [{ subject: 's', body: 'b', status: 'open' }],
  ])('rejects the body %o with 400', async (body) => {
    await as('appellant').post('/communities/garden/modmail', body).expect(400);
    expect(threads.size).toBe(0);
  });
});
