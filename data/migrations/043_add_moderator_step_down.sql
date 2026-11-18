-- A moderator stepping down (DELETE /communities/:name/moderators/me).
-- community_moderation_actions.action gains moderator_left: the moderator's
-- own decision, distinct from moderator_removed (the creator's), so the log
-- tells the two apart without comparing actor and target.
-- notifications.type gains community_moderator_left, sent to the creator
-- with the former moderator as the actor and the community as the subject.
-- Both enums are appended to, never reordered (see 025_add_community_suspension).
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE community_moderation_actions: moderator_left.
--   2. SHOW CREATE TABLE notifications: community_moderator_left.
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
    'ownership_transferred',
    'moderator_left'
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
    'community_ownership_transferred',
    'community_moderator_left'
  ) NOT NULL;
