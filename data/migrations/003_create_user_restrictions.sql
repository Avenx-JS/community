-- Creates account restriction history and lookup indexes.
-- The lift rule (chk_user_restrictions_lift) names lifted_by, whose foreign
-- key is ON DELETE SET NULL, so MySQL 8 refuses it as a CHECK; the trigger
-- pair at the end enforces it with the CHECK error.
-- Not safely re-runnable: if the table exists but this version is unrecorded,
-- verify its definition and its triggers (SHOW TRIGGERS) before recording
-- this migration manually.
CREATE TABLE user_restrictions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    type ENUM('suspension', 'ban') NOT NULL,
    reason TEXT NOT NULL,
    created_by VARCHAR(36) NULL,
    expires_at TIMESTAMP NULL,
    lifted_at TIMESTAMP NULL,
    lifted_by VARCHAR(36) NULL,
    lift_reason TEXT NULL,
    report_id VARCHAR(36) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_restrictions_active (user_id, lifted_at, expires_at),
    INDEX idx_user_restrictions_user_created (user_id, created_at),
    INDEX idx_user_restrictions_expires_at (expires_at),
    INDEX idx_user_restrictions_created_by (created_by),
    CONSTRAINT chk_user_restrictions_expiry CHECK (
        (type = 'suspension' AND expires_at IS NOT NULL) OR
        (type = 'ban' AND expires_at IS NULL)
    ),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (lifted_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (report_id) REFERENCES user_reports(id) ON DELETE SET NULL
);

-- chk_user_restrictions_lift (003_create_user_restrictions): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_user_restrictions_lift_insert BEFORE INSERT ON user_restrictions FOR EACH ROW
BEGIN
  IF NOT ((NEW.lifted_at IS NULL AND NEW.lifted_by IS NULL AND NEW.lift_reason IS NULL) OR NEW.lifted_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_user_restrictions_lift'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_user_restrictions_lift_update BEFORE UPDATE ON user_restrictions FOR EACH ROW
BEGIN
  IF NOT ((NEW.lifted_at IS NULL AND NEW.lifted_by IS NULL AND NEW.lift_reason IS NULL) OR NEW.lifted_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_user_restrictions_lift'' is violated.';
  END IF;
END$$
DELIMITER ;
