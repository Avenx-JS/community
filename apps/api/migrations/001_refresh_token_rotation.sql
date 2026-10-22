ALTER TABLE auth_sessions
    ADD COLUMN session_id VARCHAR(36) NULL;

UPDATE auth_sessions
SET session_id = UUID()
WHERE session_id IS NULL;

ALTER TABLE auth_sessions
    MODIFY session_id VARCHAR(36) NOT NULL,
    ADD UNIQUE KEY unique_auth_sessions_session_id (session_id);

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
