-- Covering indexes for the moderation analytics aggregates: reports submitted
-- per range (by day and reason) and reports decided per range (outcome and
-- time to review). Not safely re-runnable after partial application; inspect
-- which of the two indexes exist before completing this migration manually.
CREATE INDEX idx_user_reports_created_reason
  ON user_reports (created_at, reason);

CREATE INDEX idx_user_reports_reviewed
  ON user_reports (reviewed_at, status, resolution, created_at);
