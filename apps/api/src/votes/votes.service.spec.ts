import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MYSQL_POOL } from '../auth/auth.service';
import { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { VotesService } from './votes.service';

// Every community's rules count as accepted unless a test says otherwise.
const acceptingRuleAcceptance = {
  provide: CommunityRuleAcceptanceService,
  useValue: { assertAcceptedOrThrow: () => Promise.resolve() },
};

describe('VotesService', () => {
  let service: VotesService;
  let queries: Array<{ sql: string; values: unknown[] }>;
  let votes: Map<string, Record<string, unknown>>;
  let targetExists: boolean;

  beforeEach(async () => {
    queries = [];
    votes = new Map();
    targetExists = true;

    const connection = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
      execute: async (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes('FOR UPDATE')) {
          return [targetExists ? [{ id: values[0] }] : [], []];
        }
        if (sql.startsWith('INSERT INTO votes')) {
          const [id, userId, targetType, targetId, value] = values as [
            string,
            string,
            'post' | 'comment',
            string,
            -1 | 1,
          ];
          const key = `${userId}:${targetType}:${targetId}`;
          const prior = votes.get(key);
          votes.set(key, {
            id: prior?.id ?? id,
            user_id: userId,
            target_type: targetType,
            target_id: targetId,
            value,
            created_at: prior?.created_at ?? new Date('2026-10-22T08:00:00Z'),
          });
          return [{ affectedRows: 1 }, []];
        }
        if (sql.startsWith('SELECT id, user_id, target_type')) {
          const [userId, targetType, targetId] = values as [
            string,
            'post' | 'comment',
            string,
          ];
          const vote = votes.get(`${userId}:${targetType}:${targetId}`);
          return [vote ? [vote] : [], []];
        }
        if (sql.startsWith('SELECT COALESCE(SUM(value)')) {
          const [targetType, targetId] = values as ['post' | 'comment', string];
          const score = [...votes.values()]
            .filter(
              (vote) =>
                vote.target_type === targetType && vote.target_id === targetId,
            )
            .reduce((total, vote) => total + Number(vote.value), 0);
          return [[{ score }], []];
        }
        throw new Error(`Unexpected SQL query: ${sql}`);
      },
    };
    const pool = { getConnection: async () => connection };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VotesService,
        acceptingRuleAcceptance,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();

    service = module.get<VotesService>(VotesService);
  });

  it('creates a vote and updates it without creating a second record', async () => {
    const input = { target_type: 'post' as const, target_id: 'post-1' };

    const upvote = await service.vote({ ...input, value: 1 }, 'user-1');
    expect(upvote).toMatchObject({
      user_id: 'user-1',
      target_type: 'post',
      target_id: 'post-1',
      value: 1,
      score: 1,
    });
    const firstVoteId = upvote.id;

    const downvote = await service.vote({ ...input, value: -1 }, 'user-1');
    expect(downvote).toMatchObject({ id: firstVoteId, value: -1, score: -1 });
    expect(votes.size).toBe(1);
    expect(
      queries.filter((query) => query.sql.startsWith('INSERT INTO votes')),
    ).toHaveLength(2);
    expect(
      queries
        .filter((query) => query.sql.startsWith('INSERT INTO votes'))
        .every((query) => query.sql.includes('ON DUPLICATE KEY UPDATE')),
    ).toBe(true);
  });

  it('includes the combined score from other votes on the target', async () => {
    await service.vote(
      { target_type: 'comment', target_id: 'comment-1', value: 1 },
      'user-1',
    );

    const otherVoteConnectionQuery = queries.find((query) =>
      query.sql.startsWith('INSERT INTO votes'),
    );
    expect(otherVoteConnectionQuery?.values[2]).toBe('comment');

    const result = await service.vote(
      { target_type: 'comment', target_id: 'comment-1', value: -1 },
      'user-2',
    );
    expect(result.score).toBe(0);
  });

  it('rejects unknown targets and rolls back the transaction', async () => {
    targetExists = false;

    await expect(
      service.vote(
        { target_type: 'post', target_id: 'missing', value: 1 },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      queries.some((query) => query.sql.startsWith('INSERT INTO votes')),
    ).toBe(false);
  });
});
