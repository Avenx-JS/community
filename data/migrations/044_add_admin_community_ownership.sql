-- Platform administrators managing a community's owner and moderators
-- (POST /admin/communities/:id/owner, POST and DELETE
-- /admin/communities/:id/moderators), for communities left without a
-- reachable owner. Ownership stays communities.creator_id; nothing is added
-- but enum members, all appended (see 025_add_community_suspension).
-- admin_actions.action: community_owner_changed, community_moderator_added,
-- community_moderator_removed, each with target_type community and the
-- administrator's reason.
-- community_moderation_actions.action: admin_owner_changed,
-- admin_moderator_added, admin_moderator_removed, so the community's own log
-- shows that a platform administrator acted, and why; distinct from the
-- creator's and moderators' own actions.
-- notifications.type: community_ownership_assigned (the new owner),
-- community_ownership_revoked (the previous owner) and
-- community_moderator_assigned (a moderator added directly). Moderation
-- types: the administrator is never named.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE admin_actions: the three community_* actions.
--   2. SHOW CREATE TABLE community_moderation_actions: the three admin_* actions.
--   3. SHOW CREATE TABLE notifications: the three new types.
ALTER TABLE admin_actions
  MODIFY COLUMN action ENUM(
    'report_status_changed',
    'user_suspended',
    'user_banned',
    'restriction_lifted',
    'user_role_changed',
    'community_suspended',
    'community_restored',
    'community_updated',
    'report_assigned',
    'report_unassigned',
    'post_removed',
    'post_restored',
    'comment_removed',
    'comment_restored',
    'community_owner_changed',
    'community_moderator_added',
    'community_moderator_removed'
  ) NOT NULL;

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
    'moderator_left',
    'admin_owner_changed',
    'admin_moderator_added',
    'admin_moderator_removed'
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
    'community_moderator_left',
    'community_ownership_assigned',
    'community_ownership_revoked',
    'community_moderator_assigned'
  ) NOT NULL;
