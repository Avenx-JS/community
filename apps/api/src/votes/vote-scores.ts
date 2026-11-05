import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

export type VoteTargetType = 'post' | 'comment';

// The score of every target on one page, as a single grouped aggregate
// bounded to the page's ids: never a query or subquery per row. Served by
// idx_votes_target (target_type, target_id, value) as a covering index. A
// denormalised score column is the escalation if this is measured too slow;
// see the README ("Scores on content").
export function voteScoresSql(idCount: number): string {
  return `SELECT target_id, SUM(value) AS score FROM votes WHERE target_type = ? AND target_id IN (${Array.from({ length: idCount }, () => '?').join(', ')}) GROUP BY target_id`;
}

// Scores keyed by target id; a target without votes is absent, i.e. 0. An
// empty page issues no query.
export async function loadVoteScores(
  executor: Pick<Pool | PoolConnection, 'execute'>,
  targetType: VoteTargetType,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Map();
  }
  const [rows] = await executor.execute<
    (RowDataPacket & { target_id: string; score: number | string })[]
  >(voteScoresSql(unique.length), [targetType, ...unique]);
  return new Map(rows.map((row) => [row.target_id, Number(row.score)]));
}

// Adds score to each item from one grouped query.
export async function withVoteScores<T extends { id: string }>(
  executor: Pick<Pool | PoolConnection, 'execute'>,
  targetType: VoteTargetType,
  items: T[],
): Promise<(T & { score: number })[]> {
  const scores = await loadVoteScores(
    executor,
    targetType,
    items.map((item) => item.id),
  );
  return items.map((item) => ({ ...item, score: scores.get(item.id) ?? 0 }));
}
