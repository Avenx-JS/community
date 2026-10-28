-- Indexes for the admin analytics aggregates: registration ranges and
-- series, the active-restriction predicate, and restrictions applied per range.
-- Not safely re-runnable after partial application; inspect which of the
-- three indexes exist before completing this migration manually.
CREATE INDEX idx_users_created_at ON users (created_at);

CREATE INDEX idx_user_restrictions_unlifted
  ON user_restrictions (lifted_at, expires_at);

CREATE INDEX idx_user_restrictions_created_at
  ON user_restrictions (created_at);
