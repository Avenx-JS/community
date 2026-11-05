-- Adds soft deletion to communities. A deleted community keeps its row and
-- every row that references it: posts, comments, subscriptions, moderators,
-- rule documents and acceptances are not destroyed, because a hard delete
-- would cascade through all of them. Every read excludes deleted_at IS NOT
-- NULL instead. deleted_by is ON DELETE SET NULL, so the deletion record
-- survives the removal of the acting account. The chk_communities_deletion
-- rule forbids an actor without a timestamp; MySQL 8 refuses it as a CHECK
-- because of that ON DELETE SET NULL, so the trigger pair at the end enforces
-- it with the CHECK error. NULL for every existing community.
-- Not safely re-runnable after partial application; inspect the communities
-- columns, constraints, index and triggers (SHOW TRIGGERS) before completing
-- this migration manually after a DDL failure.
ALTER TABLE communities
  ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN deleted_by VARCHAR(36) NULL,
  ADD CONSTRAINT fk_communities_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_communities_deleted_at ON communities (deleted_at);

-- chk_communities_deletion (022_add_community_deletion): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_communities_deletion_insert BEFORE INSERT ON communities FOR EACH ROW
BEGIN
  IF NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR NEW.deleted_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_communities_deletion'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_communities_deletion_update BEFORE UPDATE ON communities FOR EACH ROW
BEGIN
  IF NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR NEW.deleted_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_communities_deletion'' is violated.';
  END IF;
END$$
DELIMITER ;
