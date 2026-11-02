-- Marks self-deleted accounts. Deletion anonymises the users row in place and
-- never deletes it, so no ON DELETE CASCADE fires: content, reports and
-- restrictions survive. NULL for every existing account.
-- Not safely re-runnable after partial application; inspect the users table
-- and index before completing this migration manually after a DDL failure.
ALTER TABLE users
  ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL;

CREATE INDEX idx_users_deleted_at ON users (deleted_at);
