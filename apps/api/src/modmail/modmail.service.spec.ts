import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import { ALLOW_RESTRICTED } from '../auth/allow-restricted.decorator';
import { ACTIVE_COMMUNITY_BAN_SQL } from '../common/active-community-ban';
import { COMMUNITY_ROLE_BY_NAME_SQL } from '../communities/community-access';
import type { NotificationsService } from '../notifications/notifications.service';
import {
  CommunityModmailController,
  OwnModmailController,
} from './modmail.controller';
import {
  COMMUNITY_AVAILABLE_SQL,
  INSERT_MESSAGE_SQL,
  INSERT_THREAD_SQL,
  LOCK_THREAD_SQL,
  MODMAIL_USER_SQL,
  ModmailService,
  RECENT_USER_THREADS_SQL,
  SET_STATUS_SQL,
  TEAM_RECIPIENTS_SQL,
  THREAD_BY_ID_SQL,
  THREAD_MESSAGES_SQL,
  TOUCH_THREAD_SQL,
} from './modmail.service';

const now = new Date('2026-11-19T10:00:00.000Z');
const MODERATORS = new Set(['creator', 'mod']);

interface Thread {
  id: string;
  community_id: string;
  user_id: string;
  subject: string;
  status: 'open' | 'archived';
  started_by: 'user' | 'moderators';
}

describe('ModmailService', () => {
  let service: ModmailService;
  let threads: Map<string, Thread>;
  let messages: Array<{
    id: string;
    thread_id: string;
    author_id: string;
    body: string;
    is_moderator: boolean;
  }>;
  let banned: boolean;
  let recentThreads: number;
  let available: boolean;
  let writes: Array<{ sql: string; values: unknown[] }>;
  let recordMany: jest.Mock;
  let log: string[];

  const usernames: Record<string, string> = {
    creator: 'founder',
    mod: 'mod_jane',
    appellant: 'appellant',
    other: 'other_user',
  };

  beforeEach(() => {
    threads = new Map();
    messages = [];
    banned = false;
    recentThreads = 0;
    available = true;
    writes = [];
    log = [];
    const rows = (value: unknown) => Promise.resolve([value, []]);
    const threadRow = (thread: Thread) => ({
      ...thread,
      community_name: 'garden',
      username: usernames[thread.user_id],
      created_at: now,
      last_message_at: now,
    });
    const execute = (sql: string, values: unknown[] = []) => {
      const [first] = values as string[];
      if (sql === COMMUNITY_ROLE_BY_NAME_SQL) {
        return rows(
          values[2] === 'garden'
            ? [
                {
                  id: 'k-1',
                  name: 'garden',
                  creator_id: 'creator',
                  visibility: 'public',
                  can_moderate: MODERATORS.has(first) ? 1 : 0,
                },
              ]
            : [],
        );
      }
      if (sql === ACTIVE_COMMUNITY_BAN_SQL) {
        return rows(banned ? [{ id: 'b-1' }] : []);
      }
      if (sql === RECENT_USER_THREADS_SQL) {
        return rows([{ total: recentThreads, retry_after: 3600 }]);
      }
      if (sql === MODMAIL_USER_SQL) {
        const id = Object.keys(usernames).find((k) => usernames[k] === first);
        return rows(id ? [{ id, username: first }] : []);
      }
      if (sql === THREAD_BY_ID_SQL || sql === LOCK_THREAD_SQL) {
        const thread = threads.get(first);
        return rows(thread ? [threadRow(thread)] : []);
      }
      if (sql === THREAD_MESSAGES_SQL) {
        return rows(
          messages
            .filter((m) => m.thread_id === first)
            .map((m) => ({
              ...m,
              author_username: usernames[m.author_id],
              created_at: now,
            })),
        );
      }
      if (sql === TEAM_RECIPIENTS_SQL) {
        return rows([{ id: 'creator' }, { id: 'mod' }]);
      }
      if (sql === COMMUNITY_AVAILABLE_SQL) {
        return rows(available ? [{ available: 1 }] : []);
      }
      writes.push({ sql, values });
      if (sql === INSERT_THREAD_SQL) {
        const [id, community, user, subject, startedBy] = values as string[];
        threads.set(id, {
          id,
          community_id: community,
          user_id: user,
          subject,
          status: 'open',
          started_by: startedBy as Thread['started_by'],
        });
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
          is_moderator: isModerator,
        });
      }
      if (sql === TOUCH_THREAD_SQL || sql === SET_STATUS_SQL) {
        threads.get(values[1] as string)!.status =
          values[0] as Thread['status'];
      }
      return rows({ affectedRows: 1 });
    };
    const connection = {
      beginTransaction: () => Promise.resolve(),
      commit: () => {
        log.push('commit');
        return Promise.resolve();
      },
      rollback: () => {
        log.push('rollback');
        return Promise.resolve();
      },
      release: () => undefined,
      execute,
    };
    recordMany = jest.fn(() => {
      log.push('notify');
      return Promise.resolve();
    });
    service = new ModmailService(
      {
        execute,
        getConnection: () => Promise.resolve(connection),
      } as unknown as Pool,
      { recordMany } as unknown as NotificationsService,
    );
  });

  const notified = () =>
    (
      recordMany.mock.calls as unknown as Array<
        [unknown, Array<Record<string, unknown>>]
      >
    ).flatMap(([, entries]) => entries);
  const appeal = () =>
    service.startAsUser('garden', 'appellant', {
      subject: 'About my ban',
      body: 'I think this was a mistake.',
    });

  describe('a user writing to the team', () => {
    it('opens a thread, notifies the team without an actor, in one transaction', async () => {
      const thread = await appeal();
      expect(thread).toMatchObject({
        community_name: 'garden',
        subject: 'About my ban',
        status: 'open',
        started_by: 'user',
        username: 'appellant',
        messages: [
          {
            body: 'I think this was a mistake.',
            is_moderator: false,
            author_label: 'appellant',
            author_username: 'appellant',
          },
        ],
      });
      expect(notified()).toEqual(
        ['creator', 'mod'].map((recipientId) => ({
          recipientId,
          type: 'modmail_message',
          actorId: null,
          subjectType: 'modmail_message',
          subjectId: messages[0].id,
          communityId: 'k-1',
          metadata: {
            community_name: 'garden',
            thread_id: thread.id,
            thread_subject: 'About my ban',
            excerpt: 'I think this was a mistake.',
            sender: 'user',
            from_username: 'appellant',
          },
        })),
      );
      expect(log).toEqual(['notify', 'commit']);
    });

    // The appeal path: a ban lowers the limit, it does not refuse.
    it('lets a banned user appeal once a day, then answers 429', async () => {
      banned = true;
      await expect(appeal()).resolves.toMatchObject({ started_by: 'user' });
      recentThreads = 1;
      await expect(appeal()).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({ retry_after_seconds: 3600 }),
      });
      expect(service.bannedThreadsPerDay).toBe(1);
    });

    it('allows three new threads a day otherwise', async () => {
      recentThreads = 2;
      await expect(appeal()).resolves.toBeDefined();
      recentThreads = 3;
      await expect(appeal()).rejects.toMatchObject({ status: 429 });
      expect(writes.filter((w) => w.sql === INSERT_THREAD_SQL)).toHaveLength(1);
    });

    it('refuses a member of the team with 409, and an unknown community with 404', async () => {
      await expect(
        service.startAsUser('garden', 'mod', { subject: 's', body: 'b' }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.startAsUser('nope', 'appellant', { subject: 's', body: 'b' }),
      ).rejects.toMatchObject({ status: 404 });
      expect(writes).toEqual([]);
    });
  });

  describe('the team writing to a user', () => {
    const warn = (actor: string, username = 'appellant') =>
      service.startAsModerator('garden', actor, {
        username,
        subject: 'A warning',
        body: 'Please stop.',
      });

    it('starts a thread with any account, which never learns which moderator wrote', async () => {
      await warn('mod');
      expect(notified()).toEqual([
        expect.objectContaining({
          recipientId: 'appellant',
          actorId: null,
          metadata: expect.not.objectContaining({
            from_username: expect.anything(),
          }),
        }),
      ]);
      expect(notified()[0].metadata).toMatchObject({ sender: 'moderators' });
      const own = await service.getOwn('appellant', messages[0].thread_id);
      expect(own.messages).toEqual([
        expect.objectContaining({
          is_moderator: true,
          author_label: 'moderators of c/garden',
          author_username: null,
        }),
      ]);
      expect(JSON.stringify(own)).not.toContain('mod_jane');
    });

    it('shows the moderator to the team', async () => {
      await warn('mod');
      const team = await service.getCommunity(
        'garden',
        'creator',
        messages[0].thread_id,
      );
      expect(team.messages[0]).toMatchObject({
        author_label: 'moderators of c/garden',
        author_username: 'mod_jane',
      });
    });

    it.each([
      ['a non-moderator', 'other', 'appellant', 403],
      ['an unknown account', 'mod', 'nobody', 404],
      ['the moderator themselves', 'mod', 'mod_jane', 400],
    ])('refuses %s', async (_, actor, username, status) => {
      await expect(warn(actor, username)).rejects.toMatchObject({ status });
      expect(writes).toEqual([]);
    });
  });

  describe('replies and status', () => {
    it('a user reply reopens an archived thread and notifies the team', async () => {
      const thread = await appeal();
      await service.setStatus('garden', 'mod', thread.id, 'archived');
      recordMany.mockClear();
      await expect(
        service.replyAsUser('appellant', thread.id, 'Any news?'),
      ).resolves.toMatchObject({ status: 'open' });
      expect(notified().map((e) => e.recipientId)).toEqual(['creator', 'mod']);
    });

    it('a team reply keeps the status and notifies the user only', async () => {
      const thread = await appeal();
      await service.setStatus('garden', 'mod', thread.id, 'archived');
      recordMany.mockClear();
      await expect(
        service.replyAsModerator(
          'garden',
          'creator',
          thread.id,
          'Final answer.',
        ),
      ).resolves.toMatchObject({ status: 'archived' });
      expect(notified().map((e) => e.recipientId)).toEqual(['appellant']);
    });

    it("answers 404 for another user's thread, and for another community's", async () => {
      const thread = await appeal();
      await expect(
        service.replyAsUser('other', thread.id, 'hi'),
      ).rejects.toMatchObject({ status: 404 });
      await expect(service.getOwn('other', thread.id)).rejects.toMatchObject({
        status: 404,
      });
      threads.get(thread.id)!.community_id = 'k-2';
      await expect(
        service.getCommunity('garden', 'mod', thread.id),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('refuses a user reply once the community is gone, with 409', async () => {
      const thread = await appeal();
      available = false;
      await expect(
        service.replyAsUser('appellant', thread.id, 'hello?'),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('archives and unarchives idempotently, team only', async () => {
      const thread = await appeal();
      writes = [];
      await service.setStatus('garden', 'mod', thread.id, 'open');
      expect(writes).toEqual([]);
      await service.setStatus('garden', 'mod', thread.id, 'archived');
      await service.setStatus('garden', 'mod', thread.id, 'archived');
      expect(writes.filter((w) => w.sql === SET_STATUS_SQL)).toHaveLength(1);
      await expect(
        service.setStatus('garden', 'appellant', thread.id, 'open'),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  // A suspended or banned account can still read and answer its threads; it
  // cannot open new ones.
  it('is open to restricted accounts on the user side only', () => {
    expect(Reflect.getMetadata(ALLOW_RESTRICTED, OwnModmailController)).toBe(
      true,
    );
    expect(
      Reflect.getMetadata(ALLOW_RESTRICTED, CommunityModmailController),
    ).toBeUndefined();
  });
});
