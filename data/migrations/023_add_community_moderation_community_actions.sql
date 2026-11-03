-- Adds community_updated and community_deleted to the community moderation
-- log, with the community target they act on, for PATCH and DELETE
-- /communities/:name. Appends to both enums, so every existing value keeps
-- its meaning. Nothing writes to community_moderation_actions before this
-- migration, so the table is empty and the rebuild is immediate.
-- Safe to re-run: MODIFY COLUMN to the same definition is a no-op.
ALTER TABLE community_moderation_actions
  MODIFY COLUMN action ENUM(
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
    'rules_published',
    'community_updated',
    'community_deleted'
  ) NOT NULL,
  MODIFY COLUMN target_type ENUM('post', 'comment', 'user', 'rule_document', 'community') NOT NULL;
