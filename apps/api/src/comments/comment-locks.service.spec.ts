import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunityModerationLogService } from '../communities/community-moderation-log.service';
import { CommentLocksService } from './comment-locks.service';
import { CommentsService } from './comments.service';

describe('CommentLocksService', () => {
  type StoredComment = {
    id: string;
    community_id: string;
    locked_at: Date | null;
    locked_by: string | null;
    removed_at: Date | null;
  };
  let service: CommentLocksService;
  let comment: StoredComment | undefined;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let log: { record: jest.Mock };
  let readFlat: jest.Mock;
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  const clock = new Date('2026-11-06T09:00:00.000Z');
  const canModerate = (actor: unknown) =>
    actor === 'creator-1' || actor === 'moderator';

  beforeEach(async () => {
    queries = [];
    comment = {
      id: 'comment-1',
      community_id: 'community-1',
      locked_at: null,
      locked_by: null,
      removed_at: null,
    };
    log = { record: jest.fn().mockResolvedValue(undefined) };
    readFlat = jest.fn((_executor: unknown, id: string) =>
      Promise.resolve({
        id,
        locked_at: comment?.locked_at ? comment.locked_at.toISOString() : null,
        locked_by: comment?.locked_by ?? null,
      }),
    );
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT comments.id, posts.community_id')) {
          return Promise.resolve([
            comment
              ? [{ ...comment, can_moderate: canModerate(values[0]) ? 1 : 0 }]
              : [],
            [],
          ]);
        }
        if (sql.startsWith('UPDATE comments SET locked_at')) {
          const locking = sql.includes('UTC_TIMESTAMP()');
          if (!comment || Boolean(comment.locked_at) === locking) {
            return Promise.resolve([{ affectedRows: 0 }, []]);
          }
          comment = {
            ...comment,
            locked_at: locking ? clock : null,
            locked_by: locking ? (values[0] as string) : null,
          };
          return Promise.resolve([{ affectedRows: 1 }, []]);
        }
        return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentLocksService,
        {
          provide: MYSQL_POOL,
          useValue: { getConnection: () => Promise.resolve(connection) },
        },
        { provide: CommentsService, useValue: { readFlat } },
        { provide: CommunityModerationLogService, useValue: log },
      ],
    }).compile();
    service = module.get(CommentLocksService);
  });

  const writes = () =>
    queries.filter(({ sql }) => sql.startsWith('UPDATE comments'));
  const expectCommittedAndReleased = () => {
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  };
  const expectRolledBackAndReleased = () => {
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  };

  it('resolves the community through comments → posts, locking only the comment', async () => {
    await service.lock('comment-1', 'moderator');
    const [read] = queries;
    expect(read.values).toEqual(['moderator', 'moderator', 'comment-1']);
    expect(read.sql).toContain(
      'INNER JOIN posts ON posts.id = comments.post_id',
    );
    expect(read.sql).toContain('FOR UPDATE OF comments');
    expect(read.sql).toContain('communities.deleted_at IS NULL');
  });

  it.each(['moderator', 'creator-1'])(
    'lets %s lock, logging comment_locked, and returns the flat comment',
    async (actor) => {
      const result = await service.lock('comment-1', actor);
      expect(writes()).toEqual([
        {
          sql: 'UPDATE comments SET locked_at = UTC_TIMESTAMP(), locked_by = ? WHERE id = ? AND locked_at IS NULL',
          values: [actor, 'comment-1'],
        },
      ]);
      expect(log.record).toHaveBeenCalledTimes(1);
      expect(log.record).toHaveBeenCalledWith(connection, {
        actorId: actor,
        communityId: 'community-1',
        action: 'comment_locked',
        targetType: 'comment',
        targetId: 'comment-1',
      });
      expect(readFlat).toHaveBeenCalledWith(connection, 'comment-1');
      expect(result).toEqual({
        id: 'comment-1',
        locked_at: clock.toISOString(),
        locked_by: actor,
      });
      expectCommittedAndReleased();
    },
  );

  it('is idempotent: locking a locked comment keeps locked_at and logs nothing', async () => {
    const earlier = new Date('2026-11-01T00:00:00.000Z');
    comment = { ...comment!, locked_at: earlier, locked_by: 'creator-1' };
    await expect(service.lock('comment-1', 'moderator')).resolves.toEqual({
      id: 'comment-1',
      locked_at: earlier.toISOString(),
      locked_by: 'creator-1',
    });
    expect(log.record).not.toHaveBeenCalled();
    expectCommittedAndReleased();
  });

  it('unlocks, logging comment_unlocked, and is idempotent', async () => {
    comment = { ...comment!, locked_at: clock, locked_by: 'moderator' };
    await service.unlock('comment-1', 'creator-1');
    expect(writes()[0]).toEqual({
      sql: 'UPDATE comments SET locked_at = NULL, locked_by = NULL WHERE id = ? AND locked_at IS NOT NULL',
      values: ['comment-1'],
    });
    expect(log.record).toHaveBeenCalledWith(connection, {
      actorId: 'creator-1',
      communityId: 'community-1',
      action: 'comment_unlocked',
      targetType: 'comment',
      targetId: 'comment-1',
    });

    log.record.mockClear();
    await service.unlock('comment-1', 'creator-1');
    expect(log.record).not.toHaveBeenCalled();
  });

  describe.each([
    [
      'lock',
      (s: CommentLocksService, actor: string) => s.lock('comment-1', actor),
    ],
    [
      'unlock',
      (s: CommentLocksService, actor: string) => s.unlock('comment-1', actor),
    ],
  ] as const)('%s', (_name, run) => {
    it.each(['author', 'stranger', 'moderator-elsewhere'])(
      'refuses %s with 403: authorship is not enough',
      async (actor) => {
        await expect(run(service, actor)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(writes()).toHaveLength(0);
        expectRolledBackAndReleased();
      },
    );

    it('answers 404 for an unknown comment', async () => {
      comment = undefined;
      await expect(run(service, 'moderator')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expectRolledBackAndReleased();
    });

    it('answers 409 for a removed comment, writing nothing', async () => {
      comment = { ...comment!, removed_at: clock };
      await expect(run(service, 'moderator')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(writes()).toHaveLength(0);
      expectRolledBackAndReleased();
    });
  });

  it('rolls the lock back when the log write fails', async () => {
    log.record.mockRejectedValueOnce(new Error('log failed'));
    await expect(service.lock('comment-1', 'moderator')).rejects.toThrow(
      'log failed',
    );
    expectRolledBackAndReleased();
  });

  it('rolls the unlock back when the log write fails', async () => {
    comment = { ...comment!, locked_at: clock, locked_by: 'moderator' };
    log.record.mockRejectedValueOnce(new Error('log failed'));
    await expect(service.unlock('comment-1', 'moderator')).rejects.toThrow(
      'log failed',
    );
    expectRolledBackAndReleased();
  });

  it('releases the connection when the transaction cannot start', async () => {
    connection.beginTransaction.mockRejectedValueOnce(new Error('no tx'));
    await expect(service.lock('comment-1', 'moderator')).rejects.toThrow(
      'no tx',
    );
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  });
});
