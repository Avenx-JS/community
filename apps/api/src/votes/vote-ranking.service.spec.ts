import { describe, expect, it } from '@jest/globals';
import type { Pool } from 'mysql2/promise';
import {
  RECOMPUTE_COMMENT_RANKING_SQL,
  RECOMPUTE_POST_RANKING_SQL,
} from '../common/content-ranking';
import type { CommunityRuleAcceptanceService } from '../communities/community-rule-acceptance.service';
import { VotesService } from './votes.service';

// The stored counters and ranks (migration 034) follow every vote write: on
// the vote's own connection, after the write and before the commit, so a
// rollback takes the recompute with it.
function harness(options: { failRecompute?: boolean } = {}) {
  const log: string[] = [];
  const recomputes: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    beginTransaction: () => {
      log.push('begin');
      return Promise.resolve();
    },
    commit: () => {
      log.push('commit');
      return Promise.resolve();
    },
    rollback: () => {
      log.push('rollback');
      return Promise.resolve();
    },
    release: () => undefined,
    execute: (sql: string, values: unknown[] = []) => {
      if (/^UPDATE (posts|comments) SET\s+upvotes/.test(sql)) {
        log.push('recompute');
        recomputes.push({ sql, values });
        return options.failRecompute
          ? Promise.reject(new Error('recompute failed'))
          : Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if (sql.startsWith('INSERT INTO votes')) {
        log.push('insert');
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      if (sql.startsWith('DELETE FROM votes')) {
        log.push('delete');
        return Promise.resolve([{ affectedRows: 1 }, []]);
      }
      // The target lookup: a visible, unremoved post or comment.
      if (sql.includes('FROM posts') || sql.includes('FROM comments')) {
        return Promise.resolve([
          [
            {
              id: 'target',
              community_id: 'community-1',
              author_id: 'author',
              removed: 0,
            },
          ],
          [],
        ]);
      }
      if (sql.startsWith('SELECT id, user_id, target_type')) {
        return Promise.resolve([
          [
            {
              id: 'vote-1',
              user_id: 'voter',
              target_type: values[1],
              target_id: values[2],
              value: 1,
              created_at: new Date('2026-11-11T00:00:00Z'),
            },
          ],
          [],
        ]);
      }
      if (sql.includes('SUM(value)')) {
        return Promise.resolve([[{ score: '1' }], []]);
      }
      if (sql.includes('FROM user_blocks')) {
        return Promise.resolve([[{ blocked: 0 }], []]);
      }
      return Promise.resolve([[], []]);
    },
  };
  const pool = {
    getConnection: () => Promise.resolve(connection),
    execute: connection.execute,
  } as unknown as Pool;
  const service = new VotesService(pool, {
    assertAcceptedOrThrow: () => Promise.resolve(),
  } as unknown as CommunityRuleAcceptanceService);
  return { service, log, recomputes };
}

describe('vote writes recompute the stored ranking', () => {
  it.each([
    ['post', RECOMPUTE_POST_RANKING_SQL],
    ['comment', RECOMPUTE_COMMENT_RANKING_SQL],
  ] as const)(
    'a %s vote recomputes its target after the write, before the commit',
    async (targetType, sql) => {
      const { service, log, recomputes } = harness();
      await service.vote(
        { target_type: targetType, target_id: 'target', value: -1 },
        'voter',
      );
      expect(recomputes).toEqual([
        { sql, values: ['target', 'target', 'target'] },
      ]);
      expect(log).toEqual(['begin', 'insert', 'recompute', 'commit']);
    },
  );

  it.each([
    ['post', RECOMPUTE_POST_RANKING_SQL],
    ['comment', RECOMPUTE_COMMENT_RANKING_SQL],
  ] as const)(
    'withdrawing a %s vote recomputes its target too',
    async (targetType, sql) => {
      const { service, log, recomputes } = harness();
      await service.withdraw(targetType, 'target', 'voter');
      expect(recomputes).toEqual([
        { sql, values: ['target', 'target', 'target'] },
      ]);
      expect(log).toEqual(['begin', 'delete', 'recompute', 'commit']);
    },
  );

  it('rolls the vote back when the recompute fails', async () => {
    const { service, log } = harness({ failRecompute: true });
    await expect(
      service.vote(
        { target_type: 'post', target_id: 'target', value: 1 },
        'voter',
      ),
    ).rejects.toThrow('recompute failed');
    expect(log).toEqual(['begin', 'insert', 'recompute', 'rollback']);
  });

  // Reading a vote changes nothing, so it recomputes nothing.
  it('leaves the ranking alone on a read', async () => {
    const { service, recomputes } = harness();
    await service.state('post', 'target', 'voter');
    expect(recomputes).toEqual([]);
  });
});
