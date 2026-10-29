-- Creates per-recipient notification records. subject_id is the triggering
-- object and is polymorphic with no foreign key, so readers render rows from
-- the metadata snapshot and never join to the subject. The unique key makes
-- generation idempotent (INSERT ... ON DUPLICATE KEY UPDATE id = id).
-- Not safely re-runnable: if the table exists but this version is unrecorded,
-- verify its definition before recording this migration manually.
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
