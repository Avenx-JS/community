-- Adds community-scoped pinning state to posts, for POST and DELETE
-- /posts/:id/pin. pinned_at IS NULL means "not pinned"; a value records when
-- the post was pinned and is also the ordering key of a community's pinned
-- set, so it is never refreshed by a repeated pin.
-- pinned_by is ON DELETE SET NULL, so a pin survives the deletion of the
-- moderator's account: readers must tolerate a NULL pinned_by on a pinned
-- post. chk_posts_pin forbids an actor without a timestamp. NULL for every
-- existing post, so every post reads as unpinned and no listing changes until
-- something is pinned.
-- idx_posts_community_pinned serves the per-community pin count that the
-- COMMUNITY_PINNED_POSTS_MAX cap needs and the "pinned posts of this
-- community" read.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE posts: pinned_at, pinned_by, fk_posts_pinned_by and
--      chk_posts_pin (all added by the first statement, or none).
--   2. SHOW INDEX FROM posts: idx_posts_community_pinned.
ALTER TABLE posts
  ADD COLUMN pinned_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN pinned_by VARCHAR(36) NULL,
  ADD CONSTRAINT fk_posts_pinned_by FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT chk_posts_pin CHECK ((pinned_at IS NULL AND pinned_by IS NULL) OR pinned_at IS NOT NULL);

CREATE INDEX idx_posts_community_pinned ON posts (community_id, pinned_at);
