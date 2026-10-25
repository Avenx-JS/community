-- Creates account-report storage and moderation queue indexes.
-- Not safely re-runnable: if the table exists but this version is unrecorded,
-- verify its definition before recording this migration manually.
CREATE TABLE user_reports (
    id VARCHAR(36) PRIMARY KEY,
    reporter_id VARCHAR(36) NULL,
    reported_user_id VARCHAR(36) NOT NULL,
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
    INDEX idx_user_reports_status_created (status, created_at),
    INDEX idx_user_reports_reported_user (reported_user_id, status),
    INDEX idx_user_reports_reporter_created (reporter_id, created_at),
    INDEX idx_user_reports_reporter_reported_status (reporter_id, reported_user_id, status),
    INDEX idx_user_reports_reviewed_by (reviewed_by),
    CONSTRAINT chk_user_reports_not_self CHECK (reporter_id IS NULL OR reporter_id <> reported_user_id),
    CONSTRAINT chk_user_reports_context CHECK (
        (context_type IS NULL AND context_id IS NULL) OR
        (context_type IS NOT NULL AND context_id IS NOT NULL)
    ),
    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);
