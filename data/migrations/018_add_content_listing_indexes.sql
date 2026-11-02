-- Composite indexes for vote aggregates and newest-first content listings.
-- idx_votes_target covers the score aggregate (target_type, target_id) and
-- includes value, so the sum is read from the index alone. The others have the
-- shape (filter, created_at, id): id is the pagination tiebreaker, so with it
-- ORDER BY created_at, id is read in index order without a filesort.
-- Do not drop the implicit single-column foreign-key indexes on posts and
-- comments: whether MySQL accepts a composite as a foreign key's supporting
-- index depends on creation order and version, and dropping them can fail the
-- ALTER or leave a constraint without its index.
-- No behaviour change; only query plans change.
-- Not safely re-runnable after partial application; inspect which of the
-- six indexes exist before completing this migration manually.
-- On populated posts, comments or votes tables this locks or copies; consider
-- running each statement as online DDL (ALGORITHM=INPLACE, LOCK=NONE).
CREATE INDEX idx_votes_target ON votes (target_type, target_id, value);

CREATE INDEX idx_posts_community_created ON posts (community_id, created_at, id);
CREATE INDEX idx_posts_author_created ON posts (author_id, created_at, id);

CREATE INDEX idx_comments_author_created ON comments (author_id, created_at, id);
CREATE INDEX idx_comments_parent_created ON comments (parent_id, created_at, id);
CREATE INDEX idx_comments_post_created ON comments (post_id, created_at, id);
