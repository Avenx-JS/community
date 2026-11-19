-- Mentions: @username in posts and comments notifies the account.
-- notifications.type gains mention (appended; see 025_add_community_suspension),
-- for a post or a comment, with its author as the actor.
-- user_preferences.notify_mentions: the account-wide switch, default on as
-- the other notification preferences.
-- idx_users_display_name: GET /users/autocomplete matches username and
-- display_name by prefix; username already has its unique index.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE notifications: mention.
--   2. SHOW CREATE TABLE user_preferences: notify_mentions.
--   3. SHOW INDEX FROM users: idx_users_display_name.
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
    'mention'
  ) NOT NULL;

ALTER TABLE user_preferences
  ADD COLUMN notify_mentions BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX idx_users_display_name ON users (display_name);
