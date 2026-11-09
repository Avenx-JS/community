CREATE DATABASE IF NOT EXISTS community;
USE community;

CREATE TABLE users (
    id VARCHAR(36) PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('user', 'moderator', 'admin') NOT NULL DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NULL DEFAULT NULL,
    display_name VARCHAR(50) NULL DEFAULT NULL,
    bio VARCHAR(500) NULL DEFAULT NULL,
    deleted_at TIMESTAMP NULL DEFAULT NULL
);

CREATE INDEX idx_users_role ON users (role);
CREATE INDEX idx_users_last_seen_at ON users (last_seen_at);
CREATE INDEX idx_users_created_at ON users (created_at);
CREATE INDEX idx_users_deleted_at ON users (deleted_at);

CREATE TABLE auth_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    session_id VARCHAR(36) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_auth_sessions_user_id (user_id),
    INDEX idx_auth_sessions_expires_at (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE auth_refresh_tokens (
    token_hash CHAR(64) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP NULL,
    revoked_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_auth_refresh_tokens_session_id (session_id),
    INDEX idx_auth_refresh_tokens_user_id (user_id),
    INDEX idx_auth_refresh_tokens_expires_at (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Single-use password reset credentials (029_create_password_reset_tokens).
CREATE TABLE password_reset_tokens (
    token_hash CHAR(64) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_password_reset_tokens_user_id (user_id),
    INDEX idx_password_reset_tokens_expires_at (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE auth_rate_limits (
    bucket_key CHAR(64) PRIMARY KEY,
    window_started_at TIMESTAMP NOT NULL,
    request_count INT UNSIGNED NOT NULL,
    INDEX idx_auth_rate_limits_window_started_at (window_started_at)
);

CREATE TABLE communities (
    id VARCHAR(36) PRIMARY KEY,
    creator_id VARCHAR(36) NOT NULL,
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL DEFAULT NULL,
    deleted_by VARCHAR(36) NULL,
    suspended_at TIMESTAMP NULL DEFAULT NULL,
    suspended_by VARCHAR(36) NULL,
    suspension_reason TEXT NULL,
    INDEX idx_communities_creator_id (creator_id),
    CONSTRAINT fk_communities_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_communities_suspended_by FOREIGN KEY (suspended_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_communities_deleted_at ON communities (deleted_at);
CREATE INDEX idx_communities_suspended_at ON communities (suspended_at);
CREATE FULLTEXT INDEX ft_communities_name_description
  ON communities (name, description);

CREATE TABLE community_subscriptions (
    user_id VARCHAR(36) NOT NULL,
    community_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, community_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
);
CREATE INDEX idx_community_subscriptions_community_created
  ON community_subscriptions (community_id, created_at, user_id);

CREATE TABLE community_moderators (
    community_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    assigned_by VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (community_id, user_id),
    INDEX idx_community_moderators_user_id (user_id),
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE community_notification_preferences (
    user_id VARCHAR(36) NOT NULL,
    community_id VARCHAR(36) NOT NULL,
    new_posts BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, community_id),
    INDEX idx_community_notification_preferences_community (community_id, new_posts),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
);

CREATE TABLE community_rule_documents (
    id VARCHAR(36) PRIMARY KEY,
    community_id VARCHAR(36) NOT NULL,
    version INT UNSIGNED NOT NULL,
    content_hash CHAR(64) NOT NULL,
    published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by VARCHAR(36) NULL,
    UNIQUE KEY unique_community_rule_version (community_id, version),
    INDEX idx_community_rule_documents_published_by (published_by),
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE community_rules (
    id VARCHAR(36) PRIMARY KEY,
    document_id VARCHAR(36) NOT NULL,
    position SMALLINT UNSIGNED NOT NULL,
    title VARCHAR(200) NOT NULL,
    body TEXT NULL,
    UNIQUE KEY unique_document_position (document_id, position),
    FOREIGN KEY (document_id) REFERENCES community_rule_documents(id) ON DELETE CASCADE
);

CREATE TABLE community_rule_acceptances (
    user_id VARCHAR(36) NOT NULL,
    document_id VARCHAR(36) NOT NULL,
    community_id VARCHAR(36) NOT NULL,
    accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, document_id),
    INDEX idx_community_rule_acceptances_user_community (user_id, community_id, accepted_at),
    INDEX idx_community_rule_acceptances_document (document_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES community_rule_documents(id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
);

CREATE TABLE community_moderation_actions (
    id VARCHAR(36) PRIMARY KEY,
    community_id VARCHAR(36) NOT NULL,
    actor_id VARCHAR(36) NULL,
    actor_username VARCHAR(50) NOT NULL,
    action ENUM(
        'post_locked',
        'post_unlocked',
        'post_removed',
        'post_restored',
        'post_pinned',
        'post_unpinned',
        'comment_locked',
        'comment_unlocked',
        'comment_removed',
        'comment_restored',
        'member_banned',
        'member_unbanned',
        'member_removed',
        'moderator_added',
        'moderator_removed',
        'rules_published',
        'community_updated',
        'community_deleted'
    ) NOT NULL,
    target_type ENUM('post', 'comment', 'user', 'rule_document', 'community') NOT NULL,
    target_id VARCHAR(36) NOT NULL,
    metadata JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_community_moderation_actions_community (community_id, created_at, id),
    INDEX idx_community_moderation_actions_actor (community_id, actor_username, created_at),
    INDEX idx_community_moderation_actions_action (community_id, action, created_at),
    INDEX idx_community_moderation_actions_target (target_type, target_id, created_at),
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE posts (
    id VARCHAR(36) PRIMARY KEY,
    title VARCHAR(300) NOT NULL,
    content TEXT,
    type ENUM('text', 'link', 'media') NOT NULL DEFAULT 'text',
    author_id VARCHAR(36) NOT NULL,
    community_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    edited_at TIMESTAMP NULL DEFAULT NULL,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    locked_by VARCHAR(36) NULL,
    removed_at TIMESTAMP NULL DEFAULT NULL,
    removed_by VARCHAR(36) NULL,
    removal_reason TEXT NULL,
    pinned_at TIMESTAMP NULL DEFAULT NULL,
    pinned_by VARCHAR(36) NULL,
    INDEX idx_posts_removed_at (removed_at),
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    CONSTRAINT fk_posts_locked_by FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_posts_removed_by FOREIGN KEY (removed_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_posts_pinned_by FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE FULLTEXT INDEX ft_posts_title_content ON posts (title, content);
CREATE INDEX idx_posts_community_created ON posts (community_id, created_at, id);
CREATE INDEX idx_posts_author_created ON posts (author_id, created_at, id);
CREATE INDEX idx_posts_community_pinned ON posts (community_id, pinned_at);

CREATE TABLE comments (
    id VARCHAR(36) PRIMARY KEY,
    post_id VARCHAR(36) NOT NULL,
    author_id VARCHAR(36) NOT NULL,
    parent_id VARCHAR(36) NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    edited_at TIMESTAMP NULL DEFAULT NULL,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    locked_by VARCHAR(36) NULL,
    removed_at TIMESTAMP NULL DEFAULT NULL,
    removed_by VARCHAR(36) NULL,
    removal_reason TEXT NULL,
    INDEX idx_comments_removed_at (removed_at),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE,
    CONSTRAINT fk_comments_locked_by FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_comments_removed_by FOREIGN KEY (removed_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE FULLTEXT INDEX ft_comments_content ON comments (content);
CREATE INDEX idx_comments_author_created ON comments (author_id, created_at, id);
CREATE INDEX idx_comments_parent_created ON comments (parent_id, created_at, id);
CREATE INDEX idx_comments_post_created ON comments (post_id, created_at, id);

CREATE TABLE votes (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    target_type ENUM('post', 'comment') NOT NULL,
    target_id VARCHAR(36) NOT NULL,
    value TINYINT NOT NULL CHECK (value IN (-1, 1)),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_target (user_id, target_type, target_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_votes_target ON votes (target_type, target_id, value);

-- A user's private bookmarks (027_create_saved_posts).
CREATE TABLE saved_posts (
    user_id VARCHAR(36) NOT NULL,
    post_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, post_id),
    INDEX idx_saved_posts_user_created (user_id, created_at, post_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- One user's private block of another (028_create_user_blocks).
CREATE TABLE user_blocks (
    blocker_id VARCHAR(36) NOT NULL,
    blocked_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id),
    INDEX idx_user_blocks_blocker_created (blocker_id, created_at, blocked_id),
    INDEX idx_user_blocks_blocked (blocked_id, blocker_id),
    CONSTRAINT chk_user_blocks_not_self CHECK (blocker_id <> blocked_id),
    FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE user_reports (
    id VARCHAR(36) PRIMARY KEY,
    reporter_id VARCHAR(36) NULL,
    reported_user_id VARCHAR(36) NULL,
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
    target_type ENUM('user', 'post', 'comment', 'community') NOT NULL DEFAULT 'user',
    target_id VARCHAR(36) NOT NULL,
    target_author_id VARCHAR(36) NULL,
    withdrawn_at TIMESTAMP NULL DEFAULT NULL,
    INDEX idx_user_reports_status_created (status, created_at),
    INDEX idx_user_reports_reported_user (reported_user_id, status),
    INDEX idx_user_reports_reporter_created (reporter_id, created_at),
    INDEX idx_user_reports_reporter_reported_status (reporter_id, reported_user_id, status),
    INDEX idx_user_reports_reviewed_by (reviewed_by),
    INDEX idx_user_reports_created_reason (created_at, reason),
    INDEX idx_user_reports_reviewed (reviewed_at, status, resolution, created_at),
    INDEX idx_user_reports_target (target_type, target_id, status),
    INDEX idx_user_reports_target_type_created (target_type, created_at),
    CONSTRAINT chk_user_reports_context CHECK (
        (context_type IS NULL AND context_id IS NULL) OR
        (context_type IS NOT NULL AND context_id IS NOT NULL)
    ),
    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_user_reports_reported_user
        FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_user_reports_target_author
        FOREIGN KEY (target_author_id) REFERENCES users(id) ON DELETE SET NULL
);

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
    INDEX idx_user_restrictions_unlifted (lifted_at, expires_at),
    INDEX idx_user_restrictions_created_at (created_at),
    CONSTRAINT chk_user_restrictions_expiry CHECK (
        (type = 'suspension' AND expires_at IS NOT NULL) OR
        (type = 'ban' AND expires_at IS NULL)
    ),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (lifted_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (report_id) REFERENCES user_reports(id) ON DELETE SET NULL
);

CREATE TABLE admin_actions (
    id VARCHAR(36) PRIMARY KEY,
    actor_id VARCHAR(36) NULL,
    actor_username VARCHAR(50) NOT NULL,
    action ENUM(
        'report_status_changed',
        'user_suspended',
        'user_banned',
        'restriction_lifted',
        'user_role_changed',
        'community_suspended',
        'community_restored',
        'community_updated'
    ) NOT NULL,
    target_type ENUM('user', 'report', 'restriction', 'community') NOT NULL,
    target_id VARCHAR(36) NOT NULL,
    metadata JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_admin_actions_created_at (created_at),
    INDEX idx_admin_actions_actor (actor_id, created_at),
    INDEX idx_admin_actions_target (target_type, target_id, created_at),
    INDEX idx_admin_actions_action (action, created_at),
    INDEX idx_admin_actions_actor_username (actor_username, created_at),
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE notifications (
    id VARCHAR(36) PRIMARY KEY,
    recipient_id VARCHAR(36) NOT NULL,
    type ENUM(
        'post_comment',
        'comment_reply',
        'community_post',
        'report_resolved',
        'restriction_applied',
        'restriction_lifted',
        'content_removed'
    ) NOT NULL,
    actor_id VARCHAR(36) NULL,
    subject_type ENUM('post', 'comment', 'report', 'restriction', 'community') NOT NULL,
    subject_id VARCHAR(36) NOT NULL,
    community_id VARCHAR(36) NULL,
    metadata JSON NULL,
    read_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_notification_event (recipient_id, type, subject_type, subject_id),
    INDEX idx_notifications_recipient_created (recipient_id, created_at, id),
    INDEX idx_notifications_recipient_unread (recipient_id, read_at, created_at),
    INDEX idx_notifications_recipient_type (recipient_id, type, created_at),
    FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
);

-- CHECK-style rules on columns whose foreign key is ON DELETE SET NULL or ON
-- UPDATE CASCADE. MySQL 8 forbids CHECK constraints on such columns (error 3823),
-- so each rule is a BEFORE INSERT and a BEFORE UPDATE trigger that fails
-- with the CHECK error (3819, ER_CHECK_CONSTRAINT_VIOLATED). Created in
-- migration order, which is the order MySQL runs them in.
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

-- chk_posts_pin (026_add_post_pinning): enforced by triggers, see the README.
DELIMITER $$
CREATE TRIGGER trg_posts_pin_insert BEFORE INSERT ON posts FOR EACH ROW
BEGIN
  IF NOT ((NEW.pinned_at IS NULL AND NEW.pinned_by IS NULL) OR NEW.pinned_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_posts_pin'' is violated.';
  END IF;
END$$
CREATE TRIGGER trg_posts_pin_update BEFORE UPDATE ON posts FOR EACH ROW
BEGIN
  IF NOT ((NEW.pinned_at IS NULL AND NEW.pinned_by IS NULL) OR NEW.pinned_at IS NOT NULL) THEN
    SIGNAL SQLSTATE 'HY000'
      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''chk_posts_pin'' is violated.';
  END IF;
END$$
DELIMITER ;

CREATE TABLE schema_migrations (
    version VARCHAR(64) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_migrations (version) VALUES
    ('000_baseline'),
    ('001_add_user_platform_role'),
    ('002_create_user_reports'),
    ('003_create_user_restrictions'),
    ('004_create_admin_actions'),
    ('005_add_user_last_seen_at'),
    ('006_add_admin_actions_actor_username_index'),
    ('007_add_analytics_indexes'),
    ('008_add_report_analytics_indexes'),
    ('009_create_community_rule_documents'),
    ('010_create_notifications'),
    ('011_create_community_notification_preferences'),
    ('012_create_community_rule_acceptances'),
    ('013_backfill_late_community_rules'),
    ('014_drop_communities_rules'),
    ('015_add_fulltext_search_indexes'),
    ('016_generalise_report_targets'),
    ('017_add_post_and_comment_content_state'),
    ('018_add_content_listing_indexes'),
    ('019_add_user_profile_fields'),
    ('020_add_user_account_deletion'),
    ('021_create_community_moderation_actions'),
    ('022_add_community_deletion'),
    ('023_add_community_moderation_community_actions'),
    ('024_add_community_subscriptions_community_index'),
    ('025_add_community_suspension'),
    ('026_add_post_pinning'),
    ('027_create_saved_posts'),
    ('028_create_user_blocks'),
    ('029_create_password_reset_tokens'),
    ('030_add_report_withdrawal');
