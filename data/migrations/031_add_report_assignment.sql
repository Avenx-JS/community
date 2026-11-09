-- Adds report assignment to user_reports, for POST and DELETE
-- /admin/reports/:id/assign, and the admin_actions enum values that record it.
-- assigned_to is who owns the work on a report; assigned_at is when they took
-- it. Both NULL means "unassigned". It is a separate fact from reviewed_by (who
-- made the decision) and from status (the decision state machine): a report
-- can be claimed while still open, and assigned to one administrator but
-- decided by another.
-- assigned_to is ON DELETE SET NULL, not CASCADE: a report must survive its
-- assignee's account, unassigned. Account deletion anonymises rather than
-- deletes, so AccountDeletionService clears the assignment itself; the foreign
-- key covers a hard delete, which can leave assigned_at set with no assignee.
-- Readers must treat assigned_to IS NULL as unassigned whatever assigned_at
-- holds. The chk_user_reports_assignment rule forbids an assignee without a
-- timestamp; MySQL 8 refuses it as a CHECK because of that ON DELETE SET NULL,
-- so the trigger pair at the end enforces it with the CHECK error. NULL for
-- every existing report, so every report reads as unassigned.
-- idx_user_reports_assigned (assigned_to, status, created_at) serves "my open
-- reports, newest first", the query the feature exists for.
--
-- ENUM rule: members may only ever be APPENDED, never reordered or removed.
-- Appending at the end is an in-place change in MySQL 8 that keeps every
-- existing value and does not rewrite the table; inserting anywhere else
-- renumbers the stored values and rebuilds it. The action list below is the
-- previous list with report_assigned and report_unassigned appended, and must
-- stay in step with ADMIN_ACTIONS in audit-log.service.ts.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE user_reports: assigned_to, assigned_at and
--      fk_user_reports_assigned_to (all added by the first statement, or none).
--   2. SHOW INDEX FROM user_reports: idx_user_reports_assigned.
--   3. SHOW CREATE TABLE admin_actions: the action list.
--      Re-running the MODIFY alone is harmless, as the result is identical.
--   4. SHOW TRIGGERS LIKE 'user_reports': trg_user_reports_assignment_insert,
--      then trg_user_reports_assignment_update.
ALTER TABLE user_reports
  ADD COLUMN assigned_to VARCHAR(36) NULL,
  ADD COLUMN assigned_at TIMESTAMP NULL DEFAULT NULL,
  ADD CONSTRAINT fk_user_reports_assigned_to FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_user_reports_assigned ON user_reports (assigned_to, status, created_at);

ALTER TABLE admin_actions
  MODIFY COLUMN action ENUM(
    'report_status_changed',
    'user_suspended',
    'user_banned',
    'restriction_lifted',
    'user_role_changed',
    'community_suspended',
    'community_restored',
    'community_updated',
    'report_assigned',
    'report_unassigned'
  ) NOT NULL;

-- chk_user_reports_assignment (031_add_report_assignment): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_user_reports_assignment_insert BEFORE INSERT ON user_reports FOR EACH ROW
BEGIN
  IF NOT ((NEW.assigned_to IS NULL AND NEW.assigned_at IS NULL) OR NEW.assigned_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_user_reports_assignment'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_user_reports_assignment_update BEFORE UPDATE ON user_reports FOR EACH ROW
BEGIN
  IF NOT ((NEW.assigned_to IS NULL AND NEW.assigned_at IS NULL) OR NEW.assigned_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_user_reports_assignment'' is violated.';
  END IF;
END$$
DELIMITER ;
