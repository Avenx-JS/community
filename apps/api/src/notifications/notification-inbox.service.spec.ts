import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { MYSQL_POOL } from '../auth/auth.service';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import {
  buildNotificationListQuery,
  DELETE_NOTIFICATION_SQL,
  MARK_ALL_READ_SQL,
  MARK_READ_SQL,
  MARK_UNREAD_SQL,
  NotificationInboxService,
  toNotificationDto,
  UNREAD_COUNT_SQL,
} from './notification-inbox.service';

const query = (input: Record<string, unknown> = {}) =>
  plainToInstance(ListNotificationsDto, input);

const row = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'notification-1',
    type: 'comment_reply',
    subject_type: 'comment',
    subject_id: 'deleted-comment',
    community_id: 'community-1',
    metadata: {
      actor_username: 'someone',
      community_name: 'gardening',
      post_id: 'post-1',
      parent_comment_id: 'comment-0',
      excerpt: 'Same here.',
    },
    read_at: null,
    created_at: new Date('2026-10-22T08:00:00.000Z'),
    ...overrides,
  }) as unknown as Parameters<typeof toNotificationDto>[0];

describe('NotificationInboxService', () => {
  let service: NotificationInboxService;
  let calls: Array<{ sql: string; values: unknown[] }>;
  let results: unknown[][];

  beforeEach(async () => {
    calls = [];
    results = [];
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve([results.shift() ?? [], []]);
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        NotificationInboxService,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();
    service = module.get(NotificationInboxService);
  });

  describe('list', () => {
    it('binds the recipient first and pages newest first by default', async () => {
      results = [[row()], [{ total: 41 }]];

      const result = await service.list(
        'user-a',
        query({ page: '3', limit: '20' }),
      );

      expect(calls[0].sql).toBe(
        'SELECT id, type, subject_type, subject_id, community_id, metadata, read_at, created_at FROM notifications WHERE recipient_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      );
      expect(calls[0].values).toEqual(['user-a', 20, 40]);
      expect(calls[1].sql).toBe(
        'SELECT COUNT(*) AS total FROM notifications WHERE recipient_id = ?',
      );
      expect(calls[1].values).toEqual(['user-a']);
      expect(result).toMatchObject({ page: 3, limit: 20, total: 41 });
      expect(result.items).toHaveLength(1);
    });

    it('returns an empty envelope for an empty inbox', async () => {
      results = [[], [{ total: 0 }]];

      await expect(service.list('user-a', query())).resolves.toEqual({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
      });
    });

    it('never joins to posts, comments, users or communities', async () => {
      results = [[], [{ total: 0 }], [row()]];
      await service.list(
        'user-a',
        query({ read: 'false', type: 'post_comment', community_id: 'c-1' }),
      );
      await service.findOne('user-a', 'notification-1');

      for (const call of calls) {
        expect(call.sql).not.toMatch(/\bJOIN\b|\bposts\b|\bcomments\b/i);
        expect(call.sql).not.toContain('actor_id');
      }
    });
  });

  describe('buildNotificationListQuery', () => {
    it.each([
      [{ read: 'false' }, 'recipient_id = ? AND read_at IS NULL', ['user-a']],
      [
        { read: 'true' },
        'recipient_id = ? AND read_at IS NOT NULL',
        ['user-a'],
      ],
      [
        { type: 'restriction_applied' },
        'recipient_id = ? AND type = ?',
        ['user-a', 'restriction_applied'],
      ],
      [
        { community_id: 'community-1' },
        'recipient_id = ? AND community_id = ?',
        ['user-a', 'community-1'],
      ],
      [
        { read: 'false', type: 'post_comment', community_id: 'c-1' },
        'recipient_id = ? AND read_at IS NULL AND type = ? AND community_id = ?',
        ['user-a', 'post_comment', 'c-1'],
      ],
    ])('filters %o', (input, where, filterValues) => {
      const built = buildNotificationListQuery('user-a', query(input));

      expect(built.sql).toContain(`WHERE ${where} ORDER BY`);
      expect(built.countSql).toBe(
        `SELECT COUNT(*) AS total FROM notifications WHERE ${where}`,
      );
      expect(built.values).toEqual([...filterValues, 20, 0]);
    });

    it('reverses both order columns for sort=oldest', () => {
      const built = buildNotificationListQuery(
        'user-a',
        query({ sort: 'oldest', page: '2', limit: '5' }),
      );

      expect(built.sql).toContain(
        'ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?',
      );
      expect(built.values).toEqual(['user-a', 5, 5]);
    });

    it('places limit and offset at the last page bound', () => {
      const built = buildNotificationListQuery(
        'user-a',
        query({ page: '10000', limit: '100' }),
      );

      expect(built.values.slice(-2)).toEqual([100, 999900]);
    });
  });

  it('counts only unread rows for the recipient', async () => {
    results = [[{ unread: '7' }]];

    await expect(service.unreadCount('user-a')).resolves.toEqual({
      unread: 7,
    });
    expect(calls[0]).toEqual({ sql: UNREAD_COUNT_SQL, values: ['user-a'] });
    expect(UNREAD_COUNT_SQL).toBe(
      'SELECT COUNT(*) AS unread FROM notifications WHERE recipient_id = ? AND read_at IS NULL',
    );

    results = [[{ unread: 0 }]];
    await expect(service.unreadCount('user-b')).resolves.toEqual({
      unread: 0,
    });
  });

  describe('findOne', () => {
    it('scopes the lookup to the recipient and does not write', async () => {
      results = [[row()]];

      await service.findOne('user-a', 'notification-1');

      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain('WHERE id = ? AND recipient_id = ?');
      expect(calls[0].sql).toMatch(/^SELECT /);
      expect(calls[0].values).toEqual(['notification-1', 'user-a']);
    });

    it('reports another user notification as 404', async () => {
      results = [[]];

      await expect(
        service.findOne('user-a', 'belongs-to-user-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('toNotificationDto', () => {
    it('renders a row with a deleted subject from its snapshot alone', () => {
      expect(toNotificationDto(row())).toEqual({
        id: 'notification-1',
        type: 'comment_reply',
        actor_username: 'someone',
        subject_type: 'comment',
        subject_id: 'deleted-comment',
        community_id: 'community-1',
        community_name: 'gardening',
        metadata: {
          post_id: 'post-1',
          parent_comment_id: 'comment-0',
          excerpt: 'Same here.',
        },
        read_at: null,
        created_at: '2026-10-22T08:00:00.000Z',
      });
    });

    it('keeps the snapshot username after the actor account is deleted', () => {
      // actor_id is not selected at all; a NULL actor_id changes nothing.
      expect(toNotificationDto(row({ actor_id: null })).actor_username).toBe(
        'someone',
      );
    });

    it('parses metadata stored as a JSON string and tolerates NULL or garbage', () => {
      expect(
        toNotificationDto(
          row({ metadata: '{"post_id":"post-1","excerpt":"x"}' }),
        ).metadata,
      ).toEqual({ post_id: 'post-1', excerpt: 'x' });

      for (const metadata of [null, 'not json', '[1]', 42]) {
        expect(toNotificationDto(row({ metadata }))).toMatchObject({
          actor_username: null,
          community_name: null,
          metadata: null,
        });
      }
    });

    it('never returns an actor or unknown snapshot keys for moderation types', () => {
      const dto = toNotificationDto(
        row({
          type: 'restriction_applied',
          subject_type: 'restriction',
          community_id: null,
          metadata: {
            actor_username: 'the_admin',
            restriction_type: 'suspension',
            expires_at: '2026-11-01T00:00:00.000Z',
            moderator_id: 'admin-1',
            email: 'private@example.com',
          },
        }),
      );

      expect(dto.actor_username).toBeNull();
      expect(dto.metadata).toEqual({
        restriction_type: 'suspension',
        expires_at: '2026-11-01T00:00:00.000Z',
      });
    });

    it.each([
      ['report_resolved', 'report', null, { status: 'resolved' }],
      ['restriction_applied', 'restriction', null, { restriction_type: 'ban' }],
      [
        'restriction_lifted',
        'restriction',
        null,
        { restriction_type: 'suspension' },
      ],
      ['content_removed', 'post', 'community-1', { post_title: 'Gone' }],
    ])(
      'never serialises admin-only moderation fields for %s, even if stored',
      (type, subjectType, communityId, allowed) => {
        const dto = toNotificationDto(
          row({
            type,
            subject_type: subjectType,
            community_id: communityId,
            metadata: {
              ...allowed,
              resolution: 'user_banned',
              resolution_note: 'internal note',
              reviewed_by: 'admin-1',
              reviewed_by_username: 'the_admin',
              reported_user_id: 'target-1',
              reason: 'Spam',
              lift_reason: 'Appeal accepted',
              created_by: 'admin-1',
              lifted_by: 'admin-1',
              report_id: 'report-1',
              actor_username: 'the_admin',
            },
          }),
        );

        expect(dto.metadata).toEqual(allowed);
        expect(dto.actor_username).toBeNull();
        const serialised = JSON.stringify(dto);
        for (const leaked of [
          'resolution',
          'reviewed_by',
          'reason',
          'created_by',
          'lifted_by',
          'report_id',
          'admin',
          'target-1',
          'internal note',
          'Appeal',
        ]) {
          expect(serialised).not.toContain(leaked);
        }
      },
    );

    it('formats read_at when the notification has been read', () => {
      expect(
        toNotificationDto(row({ read_at: '2026-10-23T09:30:00.000Z' })).read_at,
      ).toBe('2026-10-23T09:30:00.000Z');
    });
  });

  describe('setRead', () => {
    it('marks read with the database clock, keeping an existing read_at', async () => {
      const readAt = new Date('2026-10-23T09:30:00.000Z');
      results = [{ affectedRows: 1 } as never, [row({ read_at: readAt })]];

      const result = await service.setRead('user-a', 'notification-1', true);

      expect(calls[0]).toEqual({
        sql: MARK_READ_SQL,
        values: ['notification-1', 'user-a'],
      });
      expect(MARK_READ_SQL).toBe(
        'UPDATE notifications SET read_at = COALESCE(read_at, UTC_TIMESTAMP()) WHERE id = ? AND recipient_id = ?',
      );
      expect(calls[1].sql).toContain('WHERE id = ? AND recipient_id = ?');
      expect(calls[1].values).toEqual(['notification-1', 'user-a']);
      expect(result.read_at).toBe('2026-10-23T09:30:00.000Z');
    });

    it('marks unread by clearing read_at for the owner only', async () => {
      results = [{ affectedRows: 1 } as never, [row({ read_at: null })]];

      const result = await service.setRead('user-a', 'notification-1', false);

      expect(calls[0]).toEqual({
        sql: 'UPDATE notifications SET read_at = NULL WHERE id = ? AND recipient_id = ?',
        values: ['notification-1', 'user-a'],
      });
      expect(MARK_UNREAD_SQL).toBe(calls[0].sql);
      expect(result.read_at).toBeNull();
    });

    it.each([true, false])(
      'answers 404 with no follow-up query when nothing matched (read=%s)',
      async (read) => {
        results = [{ affectedRows: 0 } as never];

        await expect(
          service.setRead('user-a', 'belongs-to-user-b', read),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(calls).toHaveLength(1);
      },
    );
  });

  describe('markAllRead', () => {
    it('updates only the caller unread rows and reports the count', async () => {
      results = [{ affectedRows: 12 } as never];

      await expect(service.markAllRead('user-a')).resolves.toEqual({
        updated: 12,
      });
      expect(calls).toEqual([
        {
          sql: 'UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE recipient_id = ? AND read_at IS NULL',
          values: ['user-a'],
        },
      ]);
      expect(MARK_ALL_READ_SQL).toBe(calls[0].sql);
    });

    it('reports zero when nothing was unread', async () => {
      results = [{ affectedRows: 0 } as never];

      await expect(service.markAllRead('user-a')).resolves.toEqual({
        updated: 0,
      });
    });
  });

  describe('remove', () => {
    it('deletes only a row owned by the caller', async () => {
      results = [{ affectedRows: 1 } as never];

      await expect(
        service.remove('user-a', 'notification-1'),
      ).resolves.toBeUndefined();
      expect(calls).toEqual([
        {
          sql: 'DELETE FROM notifications WHERE id = ? AND recipient_id = ?',
          values: ['notification-1', 'user-a'],
        },
      ]);
      expect(DELETE_NOTIFICATION_SQL).toBe(calls[0].sql);
    });

    it('answers 404 with no follow-up query for a missing or foreign row', async () => {
      results = [{ affectedRows: 0 } as never];

      await expect(
        service.remove('user-a', 'belongs-to-user-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(calls).toHaveLength(1);
    });
  });
});
