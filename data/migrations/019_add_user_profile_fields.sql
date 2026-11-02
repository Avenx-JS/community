-- Adds the user-editable profile fields read by GET /users/me and
-- GET /users/:username and written by PATCH /users/me. Both are nullable with
-- no backfill: an existing account simply has neither.
-- Not safely re-runnable after partial application; inspect the users table
-- before completing this migration manually after a DDL failure.
ALTER TABLE users
  ADD COLUMN display_name VARCHAR(50) NULL DEFAULT NULL,
  ADD COLUMN bio VARCHAR(500) NULL DEFAULT NULL;
