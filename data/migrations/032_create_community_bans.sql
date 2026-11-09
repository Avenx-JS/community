-- Creates community_bans, for GET and POST /communities/:name/bans and
-- POST /communities/:name/bans/:username/lift. A community ban excludes one
-- account from one community, decided by that community's creator or
-- moderators. It is not a platform restriction (user_restrictions, applied by
-- administrators, excluding the account from everything): a different
-- authority, scope and record, and nothing here reads or writes
-- user_restrictions.
-- Modelled on user_restrictions so the two read alike. One row per decision,
-- never a flag on the membership row: banned, unbanned and banned again is
-- three decisions, and the history must survive. expires_at NULL is a
-- permanent ban, a timestamp a temporary one; there is no type column, so
-- unlike chk_user_restrictions_expiry no rule pairs a type with an expiry.
-- created_by and lifted_by are ON DELETE SET NULL, so a ban survives the
-- moderator's account: readers must tolerate a NULL actor. The
-- chk_community_bans_lift rule forbids a lifter or lift reason without a lift
-- time; MySQL 8 refuses it as a CHECK because lifted_by's foreign key is
-- ON DELETE SET NULL, so the trigger pair at the end enforces it with the
-- CHECK error. Bans cascade with their community and with the banned account.
-- idx_community_bans_active serves the active-ban lookup that enforcement runs
-- on every participation attempt; idx_community_bans_community_created the
-- moderators' listing; idx_community_bans_user "which communities banned me".
--
-- Not safely re-runnable after partial application: CREATE TABLE fails if the
-- table exists. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE community_bans: the three indexes and four foreign
--      keys.
--   2. SHOW TRIGGERS LIKE 'community_bans': trg_community_bans_lift_insert,
--      then trg_community_bans_lift_update.
CREATE TABLE community_bans (
    id VARCHAR(36) PRIMARY KEY,
    community_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    reason TEXT NOT NULL,
    created_by VARCHAR(36) NULL,
    expires_at TIMESTAMP NULL,
    lifted_at TIMESTAMP NULL,
    lifted_by VARCHAR(36) NULL,
    lift_reason TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_community_bans_active (community_id, user_id, lifted_at, expires_at),
    INDEX idx_community_bans_community_created (community_id, created_at, id),
    INDEX idx_community_bans_user (user_id, lifted_at, expires_at),
    CONSTRAINT fk_community_bans_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    CONSTRAINT fk_community_bans_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_community_bans_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_community_bans_lifted_by FOREIGN KEY (lifted_by) REFERENCES users(id) ON DELETE SET NULL
);

-- chk_community_bans_lift (032_create_community_bans): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_community_bans_lift_insert BEFORE INSERT ON community_bans FOR EACH ROW
BEGIN
  IF NOT ((NEW.lifted_at IS NULL AND NEW.lifted_by IS NULL AND NEW.lift_reason IS NULL) OR NEW.lifted_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_community_bans_lift'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_community_bans_lift_update BEFORE UPDATE ON community_bans FOR EACH ROW
BEGIN
  IF NOT ((NEW.lifted_at IS NULL AND NEW.lifted_by IS NULL AND NEW.lift_reason IS NULL) OR NEW.lifted_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_community_bans_lift'' is violated.';
  END IF;
END$$
DELIMITER ;
