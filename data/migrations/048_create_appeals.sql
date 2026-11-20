-- Appeals of platform administrators' decisions (POST /appeals,
-- GET /users/me/appeals, /admin/appeals): a restriction, an administrator's
-- removal of a post or comment, a community suspension. Community moderators'
-- decisions are appealed to the moderators through modmail (046), never here.
-- appeals: one per decision. original_* snapshot the decision when the appeal
-- is filed, since reversing it clears the removal's or suspension's columns:
-- original_decided_at is the restriction's created_at, the removal's
-- removed_at or the suspension's suspended_at, and tells one decision on a
-- target from a later one (uq_appeals_decision: no second appeal of the same
-- decision). open_target_id is the target while the appeal is open and NULL
-- once decided, so uq_appeals_open_target allows one open appeal per target
-- in the database as well; it also serves lookups by target.
-- chk_appeals_decision: decided_at and decision_note are set exactly when the
-- appeal is decided. decided_by and original_actor_id are SET NULL with the
-- administrator's account, so the CHECK cannot include them (MySQL refuses a
-- CHECK on a column a foreign key action writes). user_id cascades.
-- admin_actions.action gains appeal_approved and appeal_rejected, its
-- target_type appeal; notifications.type gains appeal_decided and its
-- subject_type appeal. All appended (see 025_add_community_suspension).
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW TABLES: appeals.
--   2. SHOW CREATE TABLE admin_actions: appeal_approved and appeal_rejected in
--      action, appeal in target_type.
--   3. SHOW CREATE TABLE notifications: appeal_decided in type, appeal in
--      subject_type.
CREATE TABLE appeals (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    target_type ENUM('restriction', 'post_removal', 'comment_removal', 'community_suspension') NOT NULL,
    target_id VARCHAR(36) NOT NULL,
    reason TEXT NOT NULL,
    original_actor_id VARCHAR(36) NULL,
    original_reason TEXT NULL,
    original_decided_at TIMESTAMP NOT NULL,
    status ENUM('open', 'approved', 'rejected') NOT NULL DEFAULT 'open',
    decision_note TEXT NULL,
    decided_by VARCHAR(36) NULL,
    decided_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    open_target_id VARCHAR(36) GENERATED ALWAYS AS (CASE WHEN status = 'open' THEN target_id END) STORED,
    UNIQUE KEY uq_appeals_decision (target_type, target_id, original_decided_at),
    UNIQUE KEY uq_appeals_open_target (target_type, open_target_id),
    INDEX idx_appeals_queue (status, created_at, id),
    INDEX idx_appeals_user (user_id, created_at, id),
    INDEX idx_appeals_original_actor (original_actor_id),
    INDEX idx_appeals_decided_by (decided_by),
    CONSTRAINT chk_appeals_decision CHECK ((status = 'open') = (decided_at IS NULL) AND (status = 'open') = (decision_note IS NULL)),
    CONSTRAINT fk_appeals_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_appeals_original_actor
        FOREIGN KEY (original_actor_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_appeals_decided_by
        FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
);

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
    'report_unassigned',
    'post_removed',
    'post_restored',
    'comment_removed',
    'comment_restored',
    'community_owner_changed',
    'community_moderator_added',
    'community_moderator_removed',
    'appeal_approved',
    'appeal_rejected'
  ) NOT NULL,
  MODIFY COLUMN target_type ENUM('user', 'report', 'restriction', 'community', 'post', 'comment', 'appeal') NOT NULL;

ALTER TABLE notifications
  MODIFY COLUMN type ENUM(
    'post_comment',
    'comment_reply',
    'community_post',
    'report_resolved',
    'restriction_applied',
    'restriction_lifted',
    'content_removed',
    'community_ownership_transferred',
    'community_moderator_left',
    'community_ownership_assigned',
    'community_ownership_revoked',
    'community_moderator_assigned',
    'mention',
    'modmail_message',
    'new_follower',
    'appeal_decided'
  ) NOT NULL,
  MODIFY COLUMN subject_type ENUM('post', 'comment', 'report', 'restriction', 'community', 'modmail_message', 'user', 'appeal') NOT NULL;
