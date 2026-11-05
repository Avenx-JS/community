-- Adds edit, lock and moderative-removal state to posts and comments. Nothing
-- reads or writes these columns yet. Every column defaults to NULL, so every
-- existing row reads as unedited, unlocked and present.
-- The _by columns are ON DELETE SET NULL, so the state survives deletion of
-- the acting account. The lock and removal rules forbid an actor or removal
-- reason without its timestamp; MySQL 8 refuses them as CHECK constraints
-- because of that ON DELETE SET NULL, so the trigger pairs at the end enforce
-- them with the CHECK error (inspect them with SHOW TRIGGERS).
-- Not safely re-runnable after partial application; inspect the posts and
-- comments columns, constraints and indexes before completing this migration
-- manually after a DDL failure.
ALTER TABLE posts
  ADD COLUMN edited_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN locked_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN locked_by VARCHAR(36) NULL,
  ADD COLUMN removed_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN removed_by VARCHAR(36) NULL,
  ADD COLUMN removal_reason TEXT NULL,
  ADD CONSTRAINT fk_posts_locked_by FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_posts_removed_by FOREIGN KEY (removed_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_posts_removed_at ON posts (removed_at);

ALTER TABLE comments
  ADD COLUMN edited_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN locked_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN locked_by VARCHAR(36) NULL,
  ADD COLUMN removed_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN removed_by VARCHAR(36) NULL,
  ADD COLUMN removal_reason TEXT NULL,
  ADD CONSTRAINT fk_comments_locked_by FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_comments_removed_by FOREIGN KEY (removed_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_comments_removed_at ON comments (removed_at);

-- chk_posts_lock (017_add_post_and_comment_content_state): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_posts_lock_insert BEFORE INSERT ON posts FOR EACH ROW
BEGIN
  IF NOT ((NEW.locked_at IS NULL AND NEW.locked_by IS NULL) OR NEW.locked_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_posts_lock'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_posts_lock_update BEFORE UPDATE ON posts FOR EACH ROW
BEGIN
  IF NOT ((NEW.locked_at IS NULL AND NEW.locked_by IS NULL) OR NEW.locked_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_posts_lock'' is violated.';
  END IF;
END$$
DELIMITER ;

-- chk_posts_removal (017_add_post_and_comment_content_state): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_posts_removal_insert BEFORE INSERT ON posts FOR EACH ROW
BEGIN
  IF NOT ((NEW.removed_at IS NULL AND NEW.removed_by IS NULL AND NEW.removal_reason IS NULL) OR NEW.removed_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_posts_removal'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_posts_removal_update BEFORE UPDATE ON posts FOR EACH ROW
BEGIN
  IF NOT ((NEW.removed_at IS NULL AND NEW.removed_by IS NULL AND NEW.removal_reason IS NULL) OR NEW.removed_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_posts_removal'' is violated.';
  END IF;
END$$
DELIMITER ;

-- chk_comments_lock (017_add_post_and_comment_content_state): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_comments_lock_insert BEFORE INSERT ON comments FOR EACH ROW
BEGIN
  IF NOT ((NEW.locked_at IS NULL AND NEW.locked_by IS NULL) OR NEW.locked_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_comments_lock'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_comments_lock_update BEFORE UPDATE ON comments FOR EACH ROW
BEGIN
  IF NOT ((NEW.locked_at IS NULL AND NEW.locked_by IS NULL) OR NEW.locked_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_comments_lock'' is violated.';
  END IF;
END$$
DELIMITER ;

-- chk_comments_removal (017_add_post_and_comment_content_state): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_comments_removal_insert BEFORE INSERT ON comments FOR EACH ROW
BEGIN
  IF NOT ((NEW.removed_at IS NULL AND NEW.removed_by IS NULL AND NEW.removal_reason IS NULL) OR NEW.removed_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_comments_removal'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_comments_removal_update BEFORE UPDATE ON comments FOR EACH ROW
BEGIN
  IF NOT ((NEW.removed_at IS NULL AND NEW.removed_by IS NULL AND NEW.removal_reason IS NULL) OR NEW.removed_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_comments_removal'' is violated.';
  END IF;
END$$
DELIMITER ;
