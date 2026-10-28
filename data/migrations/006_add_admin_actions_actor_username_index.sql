-- Serves the audit-log actor_username filter, which matches the username
-- snapshot so entries by deleted administrators remain findable.
-- Not safely re-runnable after success; the statement fails if the index
-- already exists. Inspect the index before re-running manually.
CREATE INDEX idx_admin_actions_actor_username
  ON admin_actions (actor_username, created_at);
