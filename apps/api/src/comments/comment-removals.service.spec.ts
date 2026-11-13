import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommentRemovalService } from './comment-removals.service';
import { CommentsService } from './comments.service';

describe('CommentRemovalService', () => {
  type Stored = {
    id: string;
    post_id: string;
    author_id: string;
    content: string;
    community_id: string;
    removed_at: Date | null;
    removed_by: string | null;
    removal_reason: string | null;
    post_removed_at: Date | null;
  };
  let service: CommentRemovalService;
  let comment: Stored | undefined;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let notifications: { record: jest.Mock };
  let log: { record: jest.Mock };
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  const clock = new Date('2026-11-07T10:00:00.000Z');
  const canModerate = (actor: unknown) =>
    actor === 'creator-1' || actor === 'moderator';

  beforeEach(async () => {
    queries = [];
    comment = {
      id: 'comment-1',
      post_id: 'post-1',
      author_id: 'author',
      content: 'Mine ripened early.',
      community_id: 'community-1',
      removed_at: null,
      removed_by: null,
      removal_reason: null,
      post_removed_at: null,
    };
    notifications = { record: jest.fn().mockResolvedValue(undefined) };
    log = { record: jest.fn().mockResolvedValue(undefined) };
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT comments.id, comments.post_id')) {
          return Promise.resolve([
            comment
              ? [{ ...comment, can_moderate: canModerate(values[0]) ? 1 : 0 }]
              : [],
            [],
          ]);
        }
        if (sql.startsWith('UPDATE comments SET removed_at')) {
          const removing = sql.includes('UTC_TIMESTAMP()');
          comment = {
            ...comment!,
            removed_at: removing ? clock : null,
            removed_by: removing ? (values[0] as string) : null,
            removal_reason: removing ? (values[1] as string | null) : null,
          };
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        if (sql.startsWith('SELECT removed_at, removed_by, removal_reason')) {
          return Promise.resolve([[comment], []]);
        }
        // Closing the comment's community reports (migration 036): none open.
        if (sql.startsWith('UPDATE user_reports')) {
          return Promise.resolve([{ affectedRows: 0 }, []]);
        }
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentRemovalService,
        {
          provide: MYSQL_POOL,
          useValue: { getConnection: () => Promise.resolve(connection) },
        },
        {
          provide: CommentsService,
          useValue: {
            readFlat: (_executor: unknown, id: string) =>
              Promise.resolve({ id, content: 'Mine ripened early.' }),
          },
        },
        { provide: NotificationsService, useValue: notifications },
        { provide: CommunityModerationLogService, useValue: log },
      ],
    }).compile();
    service = module.get(CommentRemovalService);
  });

  const writes = () =>
    queries.filter(({ sql }) => sql.startsWith('UPDATE comments'));
  const expectRolledBackAndReleased = () => {
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  };

  it.each(['moderator', 'creator-1'])(
    'lets %s remove: keeps the row, notifies without the reason or moderator, logs once',
    async (actor) => {
      const result = await service.remove(
        'comment-1',
        { reason: 'Personal attack' },
        actor,
      );
      expect(queries[0].sql).toContain('FOR UPDATE OF comments');
      expect(queries[0].sql).toContain(
        'INNER JOIN posts ON posts.id = comments.post_id',
      );
      expect(writes()).toEqual([
        {
          sql: 'UPDATE comments SET removed_at = UTC_TIMESTAMP(), removed_by = ?, removal_reason = ? WHERE id = ? AND removed_at IS NULL',
          values: [actor, 'Personal attack', 'comment-1'],
        },
      ]);
      expect(result).toEqual({
        id: 'comment-1',
        content: 'Mine ripened early.',
        removed: true,
        removed_at: clock.toISOString(),
        removed_by: actor,
        removal_reason: 'Personal attack',
        removed_by_admin: false,
      });
      expect(notifications.record).toHaveBeenCalledTimes(1);
      expect(notifications.record).toHaveBeenCalledWith(connection, {
        recipientId: 'author',
        type: 'content_removed',
        actorId: null,
        subjectType: 'comment',
        subjectId: 'comment-1',
        communityId: 'community-1',
        metadata: { excerpt: 'Mine ripened early.' },
      });
      expect(JSON.stringify(notifications.record.mock.calls)).not.toMatch(
        /Personal attack|moderator|creator-1/,
      );
      expect(log.record).toHaveBeenCalledWith(connection, {
        actorId: actor,
        communityId: 'community-1',
        action: 'comment_removed',
        targetType: 'comment',
        targetId: 'comment-1',
        metadata: { reason: 'Personal attack' },
      });
      expect(connection.commit).toHaveBeenCalledTimes(1);
      expect(connection.release).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      'author',
      'Moderators remove comments; authors delete their own with DELETE /comments/:id',
    ],
    [
      'stranger',
      'Only the community creator and moderators can remove or restore comments',
    ],
  ])('refuses %s with 403 on remove and restore', async (actor, message) => {
    await expect(service.remove('comment-1', {}, actor)).rejects.toThrow(
      new ForbiddenException(message),
    );
    expectRolledBackAndReleased();
    await expect(service.restore('comment-1', actor)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(writes()).toHaveLength(0);
  });

  it('answers 404 for an unknown comment', async () => {
    comment = undefined;
    await expect(
      service.remove('missing', {}, 'moderator'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expectRolledBackAndReleased();
  });

  it('answers 409 to removing a removed comment', async () => {
    comment = { ...comment!, removed_at: clock };
    await expect(
      service.remove('comment-1', {}, 'moderator'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(writes()).toHaveLength(0);
    expectRolledBackAndReleased();
  });

  it.each([
    ['the notification', () => notifications.record],
    ['the log entry', () => log.record],
  ])('rolls the removal back when %s cannot be written', async (_l, writer) => {
    writer().mockRejectedValueOnce(new Error('write failed'));
    await expect(service.remove('comment-1', {}, 'moderator')).rejects.toThrow(
      'write failed',
    );
    expectRolledBackAndReleased();
  });

  describe('restore', () => {
    beforeEach(() => {
      comment = { ...comment!, removed_at: clock, removed_by: 'moderator' };
    });

    it('clears all three columns, logs comment_restored and notifies nobody', async () => {
      await service.restore('comment-1', 'creator-1');
      expect(writes()).toEqual([
        {
          sql: 'UPDATE comments SET removed_at = NULL, removed_by = NULL, removal_reason = NULL WHERE id = ? AND removed_at IS NOT NULL',
          values: ['comment-1'],
        },
      ]);
      expect(log.record).toHaveBeenCalledWith(connection, {
        actorId: 'creator-1',
        communityId: 'community-1',
        action: 'comment_restored',
        targetType: 'comment',
        targetId: 'comment-1',
      });
      expect(notifications.record).not.toHaveBeenCalled();
    });

    // Migration 041: moderators cannot undo an administrator's removal.
    it.each(['moderator', 'creator-1'])(
      "refuses %s with 403 on an administrator's removal, writing nothing",
      async (actor) => {
        comment = { ...comment!, removed_by_admin: true } as typeof comment;
        await expect(service.restore('comment-1', actor)).rejects.toMatchObject(
          {
            status: 403,
            message:
              'A platform administrator removed this content; only an administrator can restore it',
          },
        );
        expect(writes()).toEqual([]);
        expect(log.record).not.toHaveBeenCalled();
        expectRolledBackAndReleased();
      },
    );

    it('answers 409 for a comment that is not removed', async () => {
      comment = { ...comment!, removed_at: null };
      await expect(
        service.restore('comment-1', 'moderator'),
      ).rejects.toBeInstanceOf(ConflictException);
      expectRolledBackAndReleased();
    });

    it('answers 409 naming the post while the post itself is removed', async () => {
      comment = { ...comment!, post_removed_at: clock };
      await expect(
        service.restore('comment-1', 'moderator'),
      ).rejects.toMatchObject({
        status: 409,
        message:
          'The post of this comment (post-1) is removed; restore the post first',
      });
      expect(writes()).toHaveLength(0);
      expectRolledBackAndReleased();
    });
  });
});
