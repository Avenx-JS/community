-- Adds platform roles to existing users.
-- Not safely re-runnable after partial application; inspect the users table
-- and index before completing this migration manually after a DDL failure.
ALTER TABLE users
  ADD COLUMN role ENUM('user', 'moderator', 'admin') NOT NULL DEFAULT 'user';

CREATE INDEX idx_users_role ON users (role);
