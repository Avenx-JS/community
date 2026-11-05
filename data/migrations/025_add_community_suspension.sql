-- Adds administrative suspension state to communities and the admin_actions
-- enum values that record it. Schema only: nothing writes or reads these
-- columns yet, so every community behaves exactly as before. The endpoint
-- that sets suspended_at must enforce it in the same change.
--
-- suspended_at IS NULL is the "not suspended" predicate. Suspension is
-- indefinite until an administrator restores it: there is deliberately no
-- expiry column. It is a separate fact from the creator's soft deletion
-- (deleted_at, migration 022), with different authority and remedy, so every
-- community read must check both predicates once suspension is enforced.
-- suspended_by is ON DELETE SET NULL, so the record survives the removal of
-- the administrator's account. The chk_communities_suspension rule forbids an
-- actor or reason without a timestamp; MySQL 8 refuses it as a CHECK because
-- of that ON DELETE SET NULL, so the trigger pair at the end enforces it with
-- the CHECK error. NULL for every existing community.
--
-- ENUM rule: members may only ever be APPENDED, never reordered or removed.
-- Appending at the end is an in-place change in MySQL 8 that keeps every
-- existing value and does not rewrite the table; inserting anywhere else
-- renumbers the stored values and rebuilds it. Both lists below are the
-- previous lists with the new members appended, and must stay in step with
-- ADMIN_ACTIONS and ADMIN_ACTION_TARGETS in audit-log.service.ts.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE communities: suspended_at, suspended_by,
--      suspension_reason and fk_communities_suspended_by (all added by the
--      first statement, or none).
--   2. SHOW INDEX FROM communities: idx_communities_suspended_at.
--   3. SHOW CREATE TABLE admin_actions: the action and target_type lists.
--      Re-running the MODIFY alone is harmless, as the result is identical.
--   4. SHOW TRIGGERS LIKE 'communities': trg_communities_suspension_insert,
--      then trg_communities_suspension_update.
ALTER TABLE communities
  ADD COLUMN suspended_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN suspended_by VARCHAR(36) NULL,
  ADD COLUMN suspension_reason TEXT NULL,
  ADD CONSTRAINT fk_communities_suspended_by FOREIGN KEY (suspended_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_communities_suspended_at ON communities (suspended_at);

ALTER TABLE admin_actions
  MODIFY COLUMN action ENUM(
    'report_status_changed',
    'user_suspended',
    'user_banned',
    'restriction_lifted',
    'user_role_changed',
    'community_suspended',
    'community_restored',
    'community_updated'
  ) NOT NULL,
  MODIFY COLUMN target_type ENUM('user', 'report', 'restriction', 'community') NOT NULL;

-- chk_communities_suspension (025_add_community_suspension): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_communities_suspension_insert BEFORE INSERT ON communities FOR EACH ROW
BEGIN
  IF NOT ((NEW.suspended_at IS NULL AND NEW.suspended_by IS NULL AND NEW.suspension_reason IS NULL) OR NEW.suspended_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_communities_suspension'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_communities_suspension_update BEFORE UPDATE ON communities FOR EACH ROW
BEGIN
  IF NOT ((NEW.suspended_at IS NULL AND NEW.suspended_by IS NULL AND NEW.suspension_reason IS NULL) OR NEW.suspended_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_communities_suspension'' is violated.';
  END IF;
END$$
DELIMITER ;
