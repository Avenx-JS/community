-- Creates append-only audit records for administrative actions.
-- Not safely re-runnable: if the table exists but this version is unrecorded,
-- verify its definition before recording this migration manually.
CREATE TABLE admin_actions (
    id VARCHAR(36) PRIMARY KEY,
    actor_id VARCHAR(36) NULL,
    actor_username VARCHAR(50) NOT NULL,
    action ENUM(
        'report_status_changed',
        'user_suspended',
        'user_banned',
        'restriction_lifted',
        'user_role_changed'
    ) NOT NULL,
    target_type ENUM('user', 'report', 'restriction') NOT NULL,
    target_id VARCHAR(36) NOT NULL,
    metadata JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_admin_actions_created_at (created_at),
    INDEX idx_admin_actions_actor (actor_id, created_at),
    INDEX idx_admin_actions_target (target_type, target_id, created_at),
    INDEX idx_admin_actions_action (action, created_at),
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);
