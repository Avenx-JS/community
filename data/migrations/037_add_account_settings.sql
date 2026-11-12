-- Account settings: email verification, email change, the session list,
-- global preferences and personal data export.
-- users.email_verified_at: when the current address was confirmed; NULL until
-- then. Existing accounts start unverified: no address was ever confirmed,
-- and marking them verified would claim a check that never happened. The
-- routes that require a verified address are listed in the README ("Email
-- verification"); reading, voting, reporting and account settings never do.
-- email_verification_tokens: single-use codes confirming the current address,
-- stored as SHA-256 hashes like password_reset_tokens. email is the address
-- the code was sent to, so a code stops working when the address changes.
-- email_changes: at most one pending change per account (the primary key),
-- applied only when the code sent to new_email is used. Its token_hash is
-- unique, so one code identifies one change.
-- auth_sessions: last_used_at (creation, then every token rotation),
-- ip_prefix (the client network, never the full address: /24 for IPv4, /48
-- for IPv6) and user_agent (truncated), shown in GET /auth/sessions.
-- user_preferences: global defaults; an account without a row has the column
-- defaults.
-- data_exports: asynchronous personal data exports. payload holds the JSON
-- until it is downloaded once or expires, then is cleared; the row stays as
-- the record of the request.
-- Every new table cascades from users, and account deletion removes their
-- rows explicitly, since anonymising never fires the cascade.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE users: email_verified_at.
--   2. SHOW TABLES: email_verification_tokens, email_changes,
--      user_preferences, data_exports.
--   3. SHOW CREATE TABLE auth_sessions: last_used_at, ip_prefix, user_agent.
ALTER TABLE users
  ADD COLUMN email_verified_at TIMESTAMP NULL DEFAULT NULL;

CREATE TABLE email_verification_tokens (
    token_hash CHAR(64) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    email VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_email_verification_tokens_user (user_id, used_at),
    CONSTRAINT fk_email_verification_tokens_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE email_changes (
    user_id VARCHAR(36) PRIMARY KEY,
    new_email VARCHAR(255) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_email_changes_token (token_hash),
    CONSTRAINT fk_email_changes_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE auth_sessions
  ADD COLUMN last_used_at TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN ip_prefix VARCHAR(64) NULL,
  ADD COLUMN user_agent VARCHAR(255) NULL;

CREATE TABLE user_preferences (
    user_id VARCHAR(36) PRIMARY KEY,
    email_notifications BOOLEAN NOT NULL DEFAULT TRUE,
    new_community_notifications BOOLEAN NOT NULL DEFAULT TRUE,
    show_nsfw BOOLEAN NOT NULL DEFAULT FALSE,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    language VARCHAR(35) NOT NULL DEFAULT 'en',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_preferences_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE data_exports (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    status ENUM('pending', 'ready', 'failed', 'downloaded', 'expired') NOT NULL DEFAULT 'pending',
    payload LONGBLOB NULL,
    size_bytes INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL DEFAULT NULL,
    expires_at TIMESTAMP NULL DEFAULT NULL,
    downloaded_at TIMESTAMP NULL DEFAULT NULL,
    INDEX idx_data_exports_user_created (user_id, created_at),
    INDEX idx_data_exports_status_expires (status, expires_at),
    CONSTRAINT fk_data_exports_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
