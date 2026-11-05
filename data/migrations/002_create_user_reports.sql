-- Creates account-report storage and moderation queue indexes.
-- The self-report rule (chk_user_reports_not_self) names reporter_id and
-- reported_user_id, whose foreign keys have referential actions, so MySQL 8
-- refuses it as a CHECK; the trigger pair at the end enforces it with the
-- CHECK error.
-- Not safely re-runnable: if the table exists but this version is unrecorded,
-- verify its definition and its triggers (SHOW TRIGGERS) before recording
-- this migration manually.
CREATE TABLE user_reports (
    id VARCHAR(36) PRIMARY KEY,
    reporter_id VARCHAR(36) NULL,
    reported_user_id VARCHAR(36) NOT NULL,
    reason ENUM('spam', 'harassment', 'hate_speech', 'sexual_content', 'self_harm', 'impersonation', 'other') NOT NULL,
    description TEXT NULL,
    context_type ENUM('post', 'comment') NULL,
    context_id VARCHAR(36) NULL,
    status ENUM('open', 'under_review', 'resolved', 'rejected') NOT NULL DEFAULT 'open',
    resolution ENUM('no_action', 'content_removed', 'user_warned', 'user_suspended', 'user_banned') NULL,
    resolution_note TEXT NULL,
    reviewed_by VARCHAR(36) NULL,
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_reports_status_created (status, created_at),
    INDEX idx_user_reports_reported_user (reported_user_id, status),
    INDEX idx_user_reports_reporter_created (reporter_id, created_at),
    INDEX idx_user_reports_reporter_reported_status (reporter_id, reported_user_id, status),
    INDEX idx_user_reports_reviewed_by (reviewed_by),
    CONSTRAINT chk_user_reports_context CHECK (
        (context_type IS NULL AND context_id IS NULL) OR
        (context_type IS NOT NULL AND context_id IS NOT NULL)
    ),
    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);

-- chk_user_reports_not_self (002_create_user_reports): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_user_reports_not_self_insert BEFORE INSERT ON user_reports FOR EACH ROW
BEGIN
  IF NOT (NEW.reporter_id IS NULL OR NEW.reporter_id <> NEW.reported_user_id) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_user_reports_not_self'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_user_reports_not_self_update BEFORE UPDATE ON user_reports FOR EACH ROW
BEGIN
  IF NOT (NEW.reporter_id IS NULL OR NEW.reporter_id <> NEW.reported_user_id) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_user_reports_not_self'' is violated.';
  END IF;
END$$
DELIMITER ;
