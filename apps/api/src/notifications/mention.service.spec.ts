import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { MentionService, mentionRecipientsSql } from './mention.service';
import type { NotificationsService } from './notifications.service';

describe('MentionService', () => {
  let service: MentionService;
  let connection: PoolConnection;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let eligible: Array<{ id: string; username: string }>;
  let recordMany: jest.Mock;

  beforeEach(() => {
    calls = [];
    eligible = [];
    connection = {
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve([
          eligible.map((row) => ({
            ...row,
            community_name: 'garden',
            author_username: 'author_1',
          })),
          [],
        ]);
      },
    } as unknown as PoolConnection;
    recordMany = jest.fn(() => Promise.resolve());
    service = new MentionService(
      {} as Pool,
      {
        recordMany,
      } as unknown as NotificationsService,
    );
  });

  const base = {
    authorId: 'author',
    communityId: 'k-1',
    subjectType: 'comment' as const,
    subjectId: 'c-1',
    postId: 'p-1',
    postTitle: 'Tomatoes',
  };

  it('resolves the mentioned names in one statement and notifies the eligible, naming the author', async () => {
    eligible = [{ id: 'u-maintainer', username: 'maintainer' }];
    await expect(
      service.record(connection, {
        ...base,
        text: '@maintainer and @nobody, can you confirm?',
        excerpt: '@maintainer and @nobody, can you confirm?',
      }),
    ).resolves.toBe(1);

    expect(calls).toEqual([
      {
        sql: mentionRecipientsSql(2),
        values: [
          'k-1',
          'author',
          'maintainer',
          'nobody',
          'author',
          'author',
          'author',
        ],
      },
    ]);
    expect(recordMany).toHaveBeenCalledWith(connection, [
      {
        recipientId: 'u-maintainer',
        type: 'mention',
        actorId: 'author',
        subjectType: 'comment',
        subjectId: 'c-1',
        communityId: 'k-1',
        metadata: {
          actor_username: 'author_1',
          community_name: 'garden',
          post_id: 'p-1',
          post_title: 'Tomatoes',
          excerpt: '@maintainer and @nobody, can you confirm?',
        },
      },
    ]);
  });

  it('runs no statement for text without mentions, or with mentions in code only', async () => {
    await service.record(connection, { ...base, text: 'no one here' });
    await service.record(connection, {
      ...base,
      text: 'use `@alice` or\n```\n@bob\n```',
    });
    expect(calls).toEqual([]);
    expect(recordMany).not.toHaveBeenCalled();
  });

  // The rules (deleted, self, blocks, ban, private membership, preference)
  // are the statement's; mention-notifications.mysql.spec.ts runs them.
  it('states every rule in the recipients statement', () => {
    const sql = mentionRecipientsSql(1);
    expect(sql).toContain('u.deleted_at IS NULL');
    expect(sql).toContain('u.id <> ?');
    expect(sql).toContain('COALESCE(p.notify_mentions, TRUE)');
    expect(sql).toContain(
      'FROM user_blocks WHERE blocker_id = u.id AND blocked_id = ?',
    );
    expect(sql).toContain(
      'FROM user_blocks WHERE blocker_id = ? AND blocked_id = u.id',
    );
    expect(sql).toContain('FROM community_bans b');
    expect(sql).toContain("c.visibility <> 'private' OR");
  });

  it('does not notify again the account the content already notifies', async () => {
    eligible = [
      { id: 'u-post-author', username: 'post_author' },
      { id: 'u-other', username: 'other' },
    ];
    await service.record(connection, {
      ...base,
      text: '@post_author @other',
      alreadyNotified: ['u-post-author'],
    });
    expect(
      (recordMany.mock.calls[0][1] as Array<{ recipientId: string }>).map(
        (entry) => entry.recipientId,
      ),
    ).toEqual(['u-other']);
  });

  it('considers at most MENTIONS_PER_ITEM names, the first ones written', async () => {
    const names = Array.from({ length: 15 }, (_, i) => `user_${i}`);
    await service.record(connection, {
      ...base,
      text: names.map((name) => `@${name}`).join(' '),
    });
    expect(service.limit).toBe(10);
    expect(calls[0].values.slice(2, -3)).toEqual(names.slice(0, 10));
  });

  it('on an edit, looks up only the names the edit adds', async () => {
    await service.record(connection, {
      ...base,
      text: 'thanks @Alice, and @bob too',
      previousText: 'thanks @alice',
    });
    expect(calls[0].values.slice(2, -3)).toEqual(['bob']);

    calls = [];
    await service.record(connection, {
      ...base,
      text: '@alice, again',
      previousText: 'thanks @alice',
    });
    expect(calls).toEqual([]);
  });

  it('writes nothing when nobody is eligible', async () => {
    await expect(
      service.record(connection, { ...base, text: '@blocked_user' }),
    ).resolves.toBe(0);
    expect(recordMany).not.toHaveBeenCalled();
  });
});
