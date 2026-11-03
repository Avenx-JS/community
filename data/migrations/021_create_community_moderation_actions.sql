-- Creates the append-only, community-scoped record of moderator decisions.
-- Separate from admin_actions, whose enums are platform-scoped and whose
-- reader is administrator-only. The action list declares every planned
-- moderator action, including those whose endpoints do not exist yet, so
-- each endpoint does not need its own ALTER TABLE ... MODIFY COLUMN.
-- actor_username snapshots the actor, so entries stay attributable after
-- actor_id is set NULL by an account deletion. target_id is polymorphic and
-- has no foreign key: entries must survive the hard deletion of their target.
-- The actor index is on the username snapshot because that is what the read
-- filter matches (see 006 for admin_actions); MySQL adds an implicit index on
-- actor_id for its foreign key.
-- Not safely re-runnable: if the table exists but this version is unrecorded,
-- drop community_moderation_actions and run this migration again.
CREATE TABLE community_moderation_actions (
    id VARCHAR(36) PRIMARY KEY,
    community_id VARCHAR(36) NOT NULL,
    actor_id VARCHAR(36) NULL,
    actor_username VARCHAR(50) NOT NULL,
    action ENUM(
        'post_locked',
        'post_unlocked',
        'post_removed',
        'post_restored',
        'post_pinned',
        'post_unpinned',
        'comment_locked',
        'comment_unlocked',
        'comment_removed',
        'comment_restored',
        'member_banned',
        'member_unbanned',
        'member_removed',
        'moderator_added',
        'moderator_removed',
        'rules_published'
    ) NOT NULL,
    target_type ENUM('post', 'comment', 'user', 'rule_document') NOT NULL,
    target_id VARCHAR(36) NOT NULL,
    metadata JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_community_moderation_actions_community (community_id, created_at, id),
    INDEX idx_community_moderation_actions_actor (community_id, actor_username, created_at),
    INDEX idx_community_moderation_actions_action (community_id, action, created_at),
    INDEX idx_community_moderation_actions_target (target_type, target_id, created_at),
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);
