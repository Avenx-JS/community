-- Creates per-member community notification preferences. Membership
-- (community_subscriptions) defines the delivery scope; a row here only mutes
-- within it, and its absence means new_posts = TRUE, so no backfill is needed.
-- Producers must read it with LEFT JOIN and COALESCE(p.new_posts, TRUE).
-- Not safely re-runnable: if the table exists but this version is unrecorded,
-- verify its definition before recording this migration manually.
CREATE TABLE community_notification_preferences (
    user_id VARCHAR(36) NOT NULL,
    community_id VARCHAR(36) NOT NULL,
    new_posts BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, community_id),
    INDEX idx_community_notification_preferences_community (community_id, new_posts),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
);
