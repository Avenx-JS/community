export interface FakeVote {
  user_id: string;
  target_type: 'post' | 'comment';
  target_id: string;
  value: -1 | 1;
}

// Answers the per-page score aggregate of loadVoteScores (src/votes/
// vote-scores.ts), or returns null for any other statement. Like the real
// GROUP BY, a target without votes has no row.
export function answerVoteScores(
  sql: string,
  values: unknown[],
  votes: readonly FakeVote[] = [],
): [unknown[], unknown[]] | null {
  if (!sql.startsWith('SELECT target_id, SUM(value) AS score FROM votes')) {
    return null;
  }
  const [targetType, ...ids] = values as [string, ...string[]];
  const scores = new Map<string, number>();
  for (const vote of votes) {
    if (vote.target_type === targetType && ids.includes(vote.target_id)) {
      scores.set(
        vote.target_id,
        (scores.get(vote.target_id) ?? 0) + vote.value,
      );
    }
  }
  return [[...scores].map(([target_id, score]) => ({ target_id, score })), []];
}
