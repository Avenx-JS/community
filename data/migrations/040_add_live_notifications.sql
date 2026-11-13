-- Live notifications: Web Push subscriptions, push dispatch state, single-use
-- tickets for the notification stream, and the push preference.
-- notifications.push_dispatched_at: when the push dispatcher claimed the
-- notification (pushed or decided not to push); NULL while pending. Every
-- notification that exists before this migration is marked dispatched, so
-- enabling push never sends a backlog.
-- push_subscriptions: a browser's PushSubscription (RFC 8030 endpoint, RFC
-- 8291 p256dh and auth keys). The endpoint is unique: a browser re-registering
-- under another account moves to it. Deleted when the push service answers
-- 404 or 410, or after repeated failures.
-- notification_stream_tickets: a single-use, short-lived ticket for
-- GET /notifications/stream, for EventSource clients that cannot send an
-- Authorization header. Stored as SHA-256 only, bound to the access token it
-- was minted with (token_hash), so the stream ends with that session.
-- user_preferences.push_notifications: the account-wide switch for Web Push.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE notifications: push_dispatched_at and
--      idx_notifications_push_pending; then that no row has it NULL.
--   2. SHOW TABLES: push_subscriptions, notification_stream_tickets.
--   3. SHOW CREATE TABLE user_preferences: push_notifications.
ALTER TABLE notifications
  ADD COLUMN push_dispatched_at TIMESTAMP NULL DEFAULT NULL,
  ADD INDEX idx_notifications_push_pending (push_dispatched_at, created_at);

UPDATE notifications SET push_dispatched_at = created_at WHERE push_dispatched_at IS NULL;

CREATE TABLE push_subscriptions (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    endpoint VARCHAR(2048) NOT NULL,
    endpoint_hash CHAR(64) NOT NULL,
    p256dh VARCHAR(128) NOT NULL,
    auth VARCHAR(32) NOT NULL,
    expires_at TIMESTAMP NULL DEFAULT NULL,
    user_agent VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_success_at TIMESTAMP NULL DEFAULT NULL,
    failure_count INT UNSIGNED NOT NULL DEFAULT 0,
    UNIQUE KEY uq_push_subscriptions_endpoint (endpoint_hash),
    INDEX idx_push_subscriptions_user (user_id, created_at),
    CONSTRAINT fk_push_subscriptions_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE notification_stream_tickets (
    ticket_hash CHAR(64) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_notification_stream_tickets_expires (expires_at),
    CONSTRAINT fk_notification_stream_tickets_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE user_preferences
  ADD COLUMN push_notifications BOOLEAN NOT NULL DEFAULT TRUE;
