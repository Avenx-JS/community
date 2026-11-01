-- Adds edit, lock and moderative-removal state to posts and comments. Nothing
-- reads or writes these columns yet. Every column defaults to NULL, so every
-- existing row reads as unedited, unlocked and present.
-- The _by columns are ON DELETE SET NULL, so the state survives deletion of
-- the acting account; the CHECK constraints forbid an actor or removal reason
-- without its timestamp.
-- Not safely re-runnable after partial application; inspect the posts and
-- comments columns, constraints and indexes before completing this migration
-- manually after a DDL failure.
ALTER TABLE posts
  ADD COLUMN edited_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN locked_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN locked_by VARCHAR(36) NULL,
  ADD COLUMN removed_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN removed_by VARCHAR(36) NULL,
  ADD COLUMN removal_reason TEXT NULL,
  ADD CONSTRAINT fk_posts_locked_by FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_posts_removed_by FOREIGN KEY (removed_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT chk_posts_lock CHECK ((locked_at IS NULL AND locked_by IS NULL) OR locked_at IS NOT NULL),
  ADD CONSTRAINT chk_posts_removal CHECK ((removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL) OR removed_at IS NOT NULL);

CREATE INDEX idx_posts_removed_at ON posts (removed_at);

ALTER TABLE comments
  ADD COLUMN edited_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN locked_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN locked_by VARCHAR(36) NULL,
  ADD COLUMN removed_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN removed_by VARCHAR(36) NULL,
  ADD COLUMN removal_reason TEXT NULL,
  ADD CONSTRAINT fk_comments_locked_by FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_comments_removed_by FOREIGN KEY (removed_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT chk_comments_lock CHECK ((locked_at IS NULL AND locked_by IS NULL) OR locked_at IS NOT NULL),
  ADD CONSTRAINT chk_comments_removal CHECK ((removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL) OR removed_at IS NOT NULL);

CREATE INDEX idx_comments_removed_at ON comments (removed_at);
