-- Persisted ranking for sort=hot|top|rising on post listings and GET /feed,
-- and sort=top|controversial on comment listings. Each rank is a function of
-- the content's vote counts and its creation time only, never of the current
-- time, so it can be stored and indexed; the expressions are defined once in
-- apps/api/src/common/content-ranking.ts, and content-ranking.spec.ts checks
-- this backfill uses them verbatim.
-- upvotes and downvotes count the votes table's rows; score is their
-- difference. VotesService recomputes all of a target's columns from the
-- votes table in the same transaction as every vote and withdrawal, so they
-- never drift and a recompute repairs any row.
-- Indexes: idx_posts_hot and idx_posts_top serve sort=hot and sort=top
-- (time=all) on the unfiltered GET /posts in index order; idx_posts_created
-- serves the created_at window of sort=top with a time filter and of
-- sort=rising. Community listings and the feed keep reading their posts by
-- community (idx_posts_community_created) and sort that set by the stored
-- column. Comment listings are bounded per post or parent and sort by the
-- stored columns over idx_comments_post_created and
-- idx_comments_parent_created.
-- The backfill reads idx_votes_target (target_type, target_id, value) once
-- per post and comment. On a large installation, run it in batches by id
-- range. Until it has run, existing posts have hot_rank and rising_rank 0
-- and sort last on hot and rising; sort=new is unaffected.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE posts: upvotes, downvotes, score, hot_rank and
--      rising_rank (all added by the first statement, or none).
--   2. SHOW CREATE TABLE comments: upvotes, downvotes, score and controversy.
--   3. The two backfill UPDATE statements are idempotent and may be re-run.
--   4. SHOW INDEX FROM posts: idx_posts_hot, idx_posts_top, idx_posts_created.
ALTER TABLE posts
  ADD COLUMN upvotes INT NOT NULL DEFAULT 0,
  ADD COLUMN downvotes INT NOT NULL DEFAULT 0,
  ADD COLUMN score INT NOT NULL DEFAULT 0,
  ADD COLUMN hot_rank DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN rising_rank DOUBLE NOT NULL DEFAULT 0;

ALTER TABLE comments
  ADD COLUMN upvotes INT NOT NULL DEFAULT 0,
  ADD COLUMN downvotes INT NOT NULL DEFAULT 0,
  ADD COLUMN score INT NOT NULL DEFAULT 0,
  ADD COLUMN controversy DOUBLE NOT NULL DEFAULT 0;

UPDATE posts SET
  upvotes = (SELECT COUNT(*) FROM votes WHERE target_type = 'post' AND target_id = posts.id AND value = 1),
  downvotes = (SELECT COUNT(*) FROM votes WHERE target_type = 'post' AND target_id = posts.id AND value = -1),
  score = upvotes - downvotes,
  hot_rank = SIGN(score) * LOG10(GREATEST(ABS(score), 1)) + (UNIX_TIMESTAMP(created_at) - 1704067200) / 45000e0,
  rising_rank = SIGN(score) * LOG10(GREATEST(ABS(score), 1)) + (UNIX_TIMESTAMP(created_at) - 1704067200) / 11250e0;

UPDATE comments SET
  upvotes = (SELECT COUNT(*) FROM votes WHERE target_type = 'comment' AND target_id = comments.id AND value = 1),
  downvotes = (SELECT COUNT(*) FROM votes WHERE target_type = 'comment' AND target_id = comments.id AND value = -1),
  score = upvotes - downvotes,
  controversy = IF(upvotes = 0 OR downvotes = 0, 0, POW(upvotes + downvotes, LEAST(upvotes, downvotes) * 1e0 / GREATEST(upvotes, downvotes)));

CREATE INDEX idx_posts_hot ON posts (hot_rank, id);
CREATE INDEX idx_posts_top ON posts (score, id);
CREATE INDEX idx_posts_created ON posts (created_at, id);
