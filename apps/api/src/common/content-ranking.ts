// The one definition of how posts and comments rank (migration 034). Every
// rank is a pure function of persisted facts (vote counts and creation time),
// never of the current time, so it can be stored, indexed and read in index
// order: no listing sorts in the application, and an unchanged post never
// moves relative to another as time passes. "Newer wins" comes from the
// creation time inside the rank itself, as with Reddit's hot formula.
//
// The SQL expressions below are the definition; the TypeScript functions are
// their mirror for tests and documentation, and
// content-ranking.spec.ts checks the migration's backfill uses these exact
// expressions.

// Rank time is counted from here, so the time term stays small.
export const RANK_EPOCH_SECONDS = 1704067200; // 2024-01-01T00:00:00Z

// hot: every 12.5 hours of age weigh as much as one order of magnitude of
// score. A post with score 10 posted 12.5 h before a post with score 1 ties
// with it.
export const HOT_DECAY_SECONDS = 45000;

// rising: the same shape, four times steeper in time (one order of magnitude
// per 3 h 7.5 min), and only over the last RISING_WINDOW_HOURS. It surfaces
// recent posts that are gathering votes, where hot still favours yesterday's.
export const RISING_DECAY_SECONDS = 11250;
export const RISING_WINDOW_HOURS = 24;

// Used in SQL with an `e0` suffix so MySQL computes in DOUBLE: an integer
// division yields DECIMAL with only div_precision_increment (4) decimals,
// which would round nearby ranks together.
const rankSql = (
  score: string,
  epochSeconds: string,
  decaySeconds: number,
): string =>
  `SIGN(${score}) * LOG10(GREATEST(ABS(${score}), 1)) + (${epochSeconds} - ${RANK_EPOCH_SECONDS}) / ${decaySeconds}e0`;

export const hotRankSql = (score: string, epochSeconds: string) =>
  rankSql(score, epochSeconds, HOT_DECAY_SECONDS);
export const risingRankSql = (score: string, epochSeconds: string) =>
  rankSql(score, epochSeconds, RISING_DECAY_SECONDS);

// controversial (comments): many votes, split evenly. 0 without both an up-
// and a downvote; otherwise (up + down) ^ (minority / majority), so 50/50
// with 10 votes (10^1 = 10) beats 9/1 with 10 votes (10^(1/9) ≈ 1.29) and
// loses to 50/50 with 20 votes (20).
export const controversySql = (up: string, down: string): string =>
  `IF(${up} = 0 OR ${down} = 0, 0, POW(${up} + ${down}, LEAST(${up}, ${down}) * 1e0 / GREATEST(${up}, ${down})))`;

const rank = (score: number, createdAt: Date, decaySeconds: number) =>
  Math.sign(score) * Math.log10(Math.max(Math.abs(score), 1)) +
  (Math.floor(createdAt.getTime() / 1000) - RANK_EPOCH_SECONDS) / decaySeconds;

export const hotRank = (score: number, createdAt: Date) =>
  rank(score, createdAt, HOT_DECAY_SECONDS);
export const risingRank = (score: number, createdAt: Date) =>
  rank(score, createdAt, RISING_DECAY_SECONDS);
export const controversy = (up: number, down: number) =>
  up === 0 || down === 0
    ? 0
    : Math.pow(up + down, Math.min(up, down) / Math.max(up, down));

// The vote counts of one target, read from idx_votes_target
// (target_type, target_id, value) as two covering lookups.
const countSql = (targetType: 'post' | 'comment', value: 1 | -1) =>
  `(SELECT COUNT(*) FROM votes WHERE target_type = '${targetType}' AND target_id = ? AND value = ${value})`;

// Recomputes a post's counters and ranks from its votes. MySQL evaluates a
// single-table UPDATE's assignments left to right, each seeing the ones
// before it, so score and the ranks use the counts just written. Bound to
// [id, id, id]. Run by every vote write, on its connection, after the
// target row was locked FOR UPDATE: concurrent votes on one post serialise
// on that lock, so the stored values always match the votes table.
export const RECOMPUTE_POST_RANKING_SQL = `UPDATE posts SET
  upvotes = ${countSql('post', 1)},
  downvotes = ${countSql('post', -1)},
  score = upvotes - downvotes,
  hot_rank = ${hotRankSql('score', 'UNIX_TIMESTAMP(created_at)')},
  rising_rank = ${risingRankSql('score', 'UNIX_TIMESTAMP(created_at)')}
WHERE id = ?`;

// The same for a comment. Bound to [id, id, id].
export const RECOMPUTE_COMMENT_RANKING_SQL = `UPDATE comments SET
  upvotes = ${countSql('comment', 1)},
  downvotes = ${countSql('comment', -1)},
  score = upvotes - downvotes,
  controversy = ${controversySql('upvotes', 'downvotes')}
WHERE id = ?`;

// The ranks of a post created now, with no votes: its INSERT sets them, as
// created_at defaults to CURRENT_TIMESTAMP in the same statement, whose
// UNIX_TIMESTAMP() is the same second.
export const NEW_POST_HOT_RANK_SQL = hotRankSql('0', 'UNIX_TIMESTAMP()');
export const NEW_POST_RISING_RANK_SQL = risingRankSql('0', 'UNIX_TIMESTAMP()');
