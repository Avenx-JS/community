import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { VotesService } from './votes.service';

type TargetType = 'post' | 'comment';

// withdraw() and state(), the service behind DELETE and GET …/vote, and the
// shared vote() path PUT …/vote delegates to. votes.service.spec.ts covers
// vote() and its upsert.
describe('VotesService vote routes', () => {
  let service: VotesService;
  let queries: Array<{ sql: string; values: unknown[]; on: 'pool' | 'tx' }>;
  let votes: Map<string, { value: -1 | 1 }>;
  let targetExists: boolean;
  let targetRemoved: number;
  let assertAccepted: jest.Mock;
  let connection: {
    beginTransaction: jest.Mock;
    commit: jest.Mock;
    rollback: jest.Mock;
    release: jest.Mock;
    execute: (sql: string, values: unknown[]) => Promise<[unknown, unknown]>;
  };
  let getConnection: jest.Mock;

  const key = (userId: string, type: string, id: string) =>
    `${userId}:${type}:${id}`;
  const scoreOf = (type: string, id: string) =>
    [...votes.entries()]
      .filter(([entry]) => entry.endsWith(`:${type}:${id}`))
      .reduce((total, [, vote]) => total + vote.value, 0);

  const answer = (sql: string, values: unknown[]): [unknown, unknown] => {
    if (
      sql.startsWith(
        'SELECT id, community_id, author_id, removed_at IS NOT NULL AS removed FROM posts',
      ) ||
      sql.startsWith('SELECT comments.id, posts.community_id')
    ) {
      return [
        targetExists
          ? [
              {
                id: values[0],
                community_id: 'community-1',
                removed: targetRemoved,
              },
            ]
          : [],
        [],
      ];
    }
    if (sql.startsWith('INSERT INTO votes')) {
      const [, userId, type, id, value] = values as [
        string,
        string,
        string,
        string,
        -1 | 1,
      ];
      votes.set(key(userId, type, id), { value });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('SELECT id, user_id, target_type')) {
      const [userId, type, id] = values as string[];
      const vote = votes.get(key(userId, type, id));
      return [
        vote
          ? [
              {
                id: 'vote-1',
                user_id: userId,
                target_type: type,
                target_id: id,
                value: vote.value,
                created_at: new Date('2026-10-22T08:00:00Z'),
              },
            ]
          : [],
        [],
      ];
    }
    if (sql.startsWith('DELETE FROM votes')) {
      const [userId, type, id] = values as string[];
      const existed = votes.delete(key(userId, type, id));
      return [{ affectedRows: existed ? 1 : 0 }, []];
    }
    if (sql.startsWith('SELECT value FROM votes')) {
      const [userId, type, id] = values as string[];
      const vote = votes.get(key(userId, type, id));
      return [vote ? [{ value: vote.value }] : [], []];
    }
    if (sql.startsWith('SELECT COALESCE(SUM(value), 0) AS score')) {
      const [type, id] = values as string[];
      // MySQL returns SUM as a decimal string.
      return [[{ score: String(scoreOf(type, id)) }], []];
    }
    // The block lookup (UserBlockPolicyService): no block here.
    if (sql.includes('FROM user_blocks')) {
      return [[{ blocked: 0 }], []];
    }
    // The ban lookup (CommunityBanPolicyService): no ban here.
    if (sql.includes('FROM community_bans')) {
      return [[], []];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  beforeEach(async () => {
    queries = [];
    votes = new Map();
    targetExists = true;
    targetRemoved = 0;
    assertAccepted = jest.fn().mockResolvedValue(undefined);
    connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: (sql, values) => {
        queries.push({ sql, values, on: 'tx' });
        return Promise.resolve(answer(sql, values));
      },
    };
    getConnection = jest.fn().mockResolvedValue(connection);
    const pool = {
      getConnection,
      execute: (sql: string, values: unknown[]) => {
        queries.push({ sql, values, on: 'pool' });
        return Promise.resolve(answer(sql, values));
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VotesService,
        { provide: MYSQL_POOL, useValue: pool },
        {
          provide: CommunityRuleAcceptanceService,
          useValue: { assertAcceptedOrThrow: assertAccepted },
        },
      ],
    }).compile();
    service = module.get(VotesService);
  });

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

  describe.each(['post', 'comment'] as const)('on a %s', (type: TargetType) => {
    const id = `${type}-1`;

    it('upserts and recomputes the score through vote()', async () => {
      votes.set(key('user-2', type, id), { value: 1 });
      await expect(
        service.vote({ target_type: type, target_id: id, value: 1 }, 'user-1'),
      ).resolves.toMatchObject({ value: 1, score: 2 });
      await expect(
        service.vote({ target_type: type, target_id: id, value: -1 }, 'user-1'),
      ).resolves.toMatchObject({ value: -1, score: 0 });
      expect(assertAccepted).toHaveBeenCalledTimes(2);
      expect(votes.size).toBe(2);
    });

    it("withdraws the caller's vote and returns the new score", async () => {
      votes.set(key('user-1', type, id), { value: 1 });
      votes.set(key('user-2', type, id), { value: -1 });

      await expect(service.withdraw(type, id, 'user-1')).resolves.toEqual({
        score: -1,
      });

      expect(votes.has(key('user-1', type, id))).toBe(false);
      expect(votes.has(key('user-2', type, id))).toBe(true);
      expect(queries[0].sql).toContain('FOR UPDATE');
      expect(
        queries.find(({ sql }) => sql.startsWith('DELETE FROM votes')),
      ).toEqual({
        sql: 'DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?',
        values: ['user-1', type, id],
        on: 'tx',
      });
      // Lock, delete and score all on the transaction's connection.
      expect(queries.every((query) => query.on === 'tx')).toBe(true);
      expectCommittedAndReleased();
    });

    it('treats a withdrawal without a vote as a no-op returning the current score', async () => {
      votes.set(key('user-2', type, id), { value: 1 });
      await expect(service.withdraw(type, id, 'user-1')).resolves.toEqual({
        score: 1,
      });
      expect(votes.size).toBe(1);
      expectCommittedAndReleased();
    });

    it('never consults the rules for a withdrawal', async () => {
      assertAccepted.mockRejectedValue(new ForbiddenException());
      await expect(service.withdraw(type, id, 'user-1')).resolves.toEqual({
        score: 0,
      });
      expect(assertAccepted).not.toHaveBeenCalled();
    });

    it('gates vote() on the rules and releases on the 403', async () => {
      assertAccepted.mockRejectedValue(new ForbiddenException());
      await expect(
        service.vote({ target_type: type, target_id: id, value: 1 }, 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(votes.size).toBe(0);
      expectRolledBackAndReleased();
    });

    it('404s an unknown target on withdraw, releasing the connection', async () => {
      targetExists = false;
      await expect(
        service.withdraw(type, 'missing', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        queries.some(({ sql }) => sql.startsWith('DELETE FROM votes')),
      ).toBe(false);
      expectRolledBackAndReleased();
    });

    it('releases when the delete fails', async () => {
      const execute = connection.execute;
      connection.execute = (sql, values) =>
        sql.startsWith('DELETE FROM votes')
          ? Promise.reject(new Error('deadlock'))
          : execute(sql, values);
      await expect(service.withdraw(type, id, 'user-1')).rejects.toThrow(
        'deadlock',
      );
      expectRolledBackAndReleased();
    });

    it("reads the caller's own vote, or null, with the score, without a transaction", async () => {
      votes.set(key('user-2', type, id), { value: -1 });

      await expect(service.state(type, id, 'user-1')).resolves.toEqual({
        value: null,
        score: -1,
      });
      votes.set(key('user-1', type, id), { value: 1 });
      await expect(service.state(type, id, 'user-1')).resolves.toEqual({
        value: 1,
        score: 0,
      });

      expect(getConnection).not.toHaveBeenCalled();
      expect(assertAccepted).not.toHaveBeenCalled();
      const lookups = queries.filter(({ sql }) =>
        sql.startsWith('SELECT value FROM votes'),
      );
      // Bound to the caller: never another user's vote.
      expect(lookups.map(({ values }) => values)).toEqual([
        ['user-1', type, id],
        ['user-1', type, id],
      ]);
      expect(queries[0].sql).not.toContain('FOR UPDATE');
    });

    it('404s an unknown target on read, reading no vote', async () => {
      targetExists = false;
      await expect(
        service.state(type, 'missing', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(queries).toHaveLength(1);
    });
  });

  it("resolves a comment's community through its post, locking only the comment", async () => {
    await service.vote(
      { target_type: 'comment', target_id: 'comment-1', value: 1 },
      'user-1',
    );
    await service.withdraw('comment', 'comment-1', 'user-1');
    await service.state('comment', 'comment-1', 'user-1');

    const lookups = queries.filter(({ sql }) =>
      sql.startsWith('SELECT comments.id, posts.community_id'),
    );
    expect(lookups).toHaveLength(3);
    for (const { sql } of lookups) {
      expect(sql).toContain('INNER JOIN posts ON posts.id = comments.post_id');
      expect(sql).toContain('communities.deleted_at IS NULL');
    }
    expect(
      lookups.map(({ sql }) => sql.includes('FOR UPDATE OF comments')),
    ).toEqual([true, true, false]);
    expect(assertAccepted).toHaveBeenCalledWith(
      'user-1',
      'community-1',
      connection,
    );
  });

  describe.each(['post', 'comment'] as const)(
    'on removed content (%s)',
    (type: TargetType) => {
      const id = `${type}-1`;
      beforeEach(() => {
        // For a comment, the flag covers the comment or its post removed.
        targetRemoved = 1;
      });

      it('refuses a vote with 409, writing nothing and releasing', async () => {
        await expect(
          service.vote(
            { target_type: type, target_id: id, value: 1 },
            'user-1',
          ),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(votes.size).toBe(0);
        expectRolledBackAndReleased();
      });

      it('still lets the caller withdraw and read their vote', async () => {
        votes.set(key('user-1', type, id), { value: 1 });
        await expect(service.withdraw(type, id, 'user-1')).resolves.toEqual({
          score: 0,
        });
        await expect(service.state(type, id, 'user-1')).resolves.toEqual({
          value: null,
          score: 0,
        });
      });
    },
  );

  it('selects the removal of a comment and of its post', async () => {
    await service.vote(
      { target_type: 'comment', target_id: 'comment-1', value: 1 },
      'user-1',
    );
    expect(queries[0].sql).toContain(
      '(comments.removed_at IS NOT NULL OR posts.removed_at IS NOT NULL) AS removed',
    );
  });
});
