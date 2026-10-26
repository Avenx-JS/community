-- Adds nullable authenticated-activity telemetry to user accounts.
-- Not safely re-runnable after partial application; inspect the column and
-- index before completing this migration manually after a DDL failure.
ALTER TABLE users
  ADD COLUMN last_seen_at TIMESTAMP NULL DEFAULT NULL;

CREATE INDEX idx_users_last_seen_at ON users (last_seen_at);
