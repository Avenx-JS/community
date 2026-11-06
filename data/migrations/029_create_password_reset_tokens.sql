-- Creates password_reset_tokens, for POST /auth/password/forgot and POST
-- /auth/password/reset. Deliberately the same shape as auth_refresh_tokens.
-- Only the SHA-256 hash of a token is stored: reading this table must not yield
-- a usable reset token. This is the most important property of the table.
-- used_at makes a token single-use. The row is kept rather than deleted, so a
-- reuse can be told apart from an unknown token internally, although callers get
-- one generic error for both.
-- idx_password_reset_tokens_user_id serves invalidating an account's other
-- tokens. idx_password_reset_tokens_expires_at exists so a future cleanup job is
-- cheap; none is added here, as auth_sessions, auth_refresh_tokens and
-- auth_rate_limits have no reaper either.
-- The foreign key cascades, but account deletion anonymises the users row rather
-- than deleting it, so AccountDeletionService removes these rows itself.
--
-- Not safely re-runnable after partial application: CREATE TABLE fails if the
-- table exists. After a failure, check SHOW CREATE TABLE password_reset_tokens
-- for the primary key, both indexes and the foreign key before recording this
-- version.
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
