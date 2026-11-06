import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

// Which of a page's posts the viewer has saved: one grouped lookup over the
// page's ids on the saved_posts primary key (user_id, post_id), never a
// query per row, as loadVoteScores does for scores. Bound to the viewer, so
// it can only ever report the caller's own saves.
export function savedFlagsSql(idCount: number): string {
  return `SELECT post_id FROM saved_posts WHERE user_id = ? AND post_id IN (${Array.from({ length: idCount }, () => '?').join(', ')})`;
}

// An anonymous viewer, or an empty page, issues no query: nothing is saved.
export async function loadSavedFlags(
  executor: Pick<Pool | PoolConnection, 'execute'>,
  viewerId: string | undefined,
  ids: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (!viewerId || unique.length === 0) {
    return new Set();
  }
  const [rows] = await executor.execute<
    (RowDataPacket & { post_id: string })[]
  >(savedFlagsSql(unique.length), [viewerId, ...unique]);
  return new Set(rows.map((row) => row.post_id));
}
