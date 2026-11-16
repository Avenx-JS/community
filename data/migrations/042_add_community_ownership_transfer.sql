-- Community ownership transfer (POST /communities/:name/transfer).
-- Ownership stays the single column communities.creator_id; a transfer
-- rewrites it, so no column is added.
-- community_moderation_actions.action gains ownership_transferred, logged
-- with the new owner as the target.
-- notifications.type gains community_ownership_transferred, sent to the new
-- owner with the former owner as the actor and the community as the subject.
-- Both enums are appended to, never reordered (see 025_add_community_suspension).
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE community_moderation_actions: ownership_transferred.
--   2. SHOW CREATE TABLE notifications: community_ownership_transferred.
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
    'community_deleted',
    'report_approved',
    'report_removed',
    'moderator_invited',
    'moderator_invite_revoked',
    'moderator_invite_declined',
    'join_request_approved',
    'join_request_denied',
    'ownership_transferred'
  ) NOT NULL;

ALTER TABLE notifications
  MODIFY COLUMN type ENUM(
    'post_comment',
    'comment_reply',
    'community_post',
    'report_resolved',
    'restriction_applied',
    'restriction_lifted',
    'content_removed',
    'community_ownership_transferred'
  ) NOT NULL;
