-- Modmail: conversations between one user and the moderator team of one
-- community (POST /communities/:name/modmail, /users/me/modmail). Private
-- user-to-user messages are out of scope; they could later share these tables.
-- modmail_threads: one user, one community; started_by tells who opened it,
-- for the per-day limits on threads a user opens.
-- modmail_messages: is_moderator marks a reply by the team. author_id is SET
-- NULL with the account; a user never sees which moderator wrote, other
-- moderators do.
-- notifications.type gains modmail_message and subject_type modmail_message:
-- a notification per message, to the user for a team reply, to the team for
-- the user's message. user_reports.target_type gains modmail_message, so a
-- message can be reported to platform administrators. All three appended
-- (see 025_add_community_suspension).
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW TABLES: modmail_threads, modmail_messages.
--   2. SHOW CREATE TABLE notifications: modmail_message in type and subject_type.
--   3. SHOW CREATE TABLE user_reports: modmail_message in target_type.
CREATE TABLE modmail_threads (
    id VARCHAR(36) PRIMARY KEY,
    community_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    subject VARCHAR(200) NOT NULL,
    status ENUM('open', 'archived') NOT NULL DEFAULT 'open',
    started_by ENUM('user', 'moderators') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_modmail_threads_community (community_id, status, last_message_at, id),
    INDEX idx_modmail_threads_user (user_id, last_message_at, id),
    INDEX idx_modmail_threads_started (user_id, community_id, started_by, created_at),
    CONSTRAINT fk_modmail_threads_community
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    CONSTRAINT fk_modmail_threads_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE modmail_messages (
    id VARCHAR(36) PRIMARY KEY,
    thread_id VARCHAR(36) NOT NULL,
    author_id VARCHAR(36) NULL,
    body TEXT NOT NULL,
    is_moderator BOOLEAN NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_modmail_messages_thread (thread_id, created_at, id),
    INDEX idx_modmail_messages_author (author_id),
    CONSTRAINT fk_modmail_messages_thread
        FOREIGN KEY (thread_id) REFERENCES modmail_threads(id) ON DELETE CASCADE,
    CONSTRAINT fk_modmail_messages_author
        FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
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
    'modmail_message'
  ) NOT NULL,
  MODIFY COLUMN subject_type ENUM('post', 'comment', 'report', 'restriction', 'community', 'modmail_message') NOT NULL;

ALTER TABLE user_reports
  MODIFY COLUMN target_type ENUM('user', 'post', 'comment', 'community', 'modmail_message') NOT NULL DEFAULT 'user';
