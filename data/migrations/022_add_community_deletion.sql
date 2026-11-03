-- Adds soft deletion to communities. A deleted community keeps its row and
-- every row that references it: posts, comments, subscriptions, moderators,
-- rule documents and acceptances are not destroyed, because a hard delete
-- would cascade through all of them. Every read excludes deleted_at IS NOT
-- NULL instead. deleted_by is ON DELETE SET NULL, so the deletion record
-- survives the removal of the acting account; the CHECK constraint forbids an
-- actor without a timestamp. NULL for every existing community.
-- Not safely re-runnable after partial application; inspect the communities
-- columns, constraints and index before completing this migration manually
-- after a DDL failure.
ALTER TABLE communities
  ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN deleted_by VARCHAR(36) NULL,
  ADD CONSTRAINT fk_communities_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT chk_communities_deletion CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR deleted_at IS NOT NULL);

CREATE INDEX idx_communities_deleted_at ON communities (deleted_at);
