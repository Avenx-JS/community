-- Following users (POST/DELETE /users/:username/follow).
-- user_follows: one row per follower and followee, as user_blocks is for
-- blocks; chk_user_follows_not_self refuses a self-follow in the database
-- (the CHECK is allowed next to ON DELETE CASCADE, as on user_blocks).
-- Account deletion removes an account's rows in both directions, as for
-- blocks; a block removes the pair's rows in both directions.
-- notifications.type gains new_follower, with the follower as the actor and
-- the follower's account as the subject: subject_type gains user.
-- user_preferences.notify_new_followers: default on.
-- Enum members are appended (see 025_add_community_suspension).
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW TABLES: user_follows.
--   2. SHOW CREATE TABLE notifications: new_follower in type, user in subject_type.
--   3. SHOW CREATE TABLE user_preferences: notify_new_followers.
CREATE TABLE user_follows (
    follower_id VARCHAR(36) NOT NULL,
    followee_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follower_id, followee_id),
    INDEX idx_user_follows_followee (followee_id, created_at, follower_id),
    INDEX idx_user_follows_follower_created (follower_id, created_at, followee_id),
    CONSTRAINT chk_user_follows_not_self CHECK (follower_id <> followee_id),
    FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (followee_id) REFERENCES users(id) ON DELETE CASCADE
);

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
    'new_follower'
  ) NOT NULL,
  MODIFY COLUMN subject_type ENUM('post', 'comment', 'report', 'restriction', 'community', 'modmail_message', 'user') NOT NULL;

ALTER TABLE user_preferences
  ADD COLUMN notify_new_followers BOOLEAN NOT NULL DEFAULT TRUE;
