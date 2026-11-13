-- Platform administration of content and roles.
-- posts.removed_by_admin, comments.removed_by_admin: TRUE when a platform
-- administrator removed the content (POST /admin/posts/:id/remove,
-- /admin/comments/:id/remove), FALSE for a community moderator's removal.
-- A moderator cannot restore an administrator's removal; the CHECK makes the
-- flag meaningless without removed_at, so clearing removed_at without the flag
-- (a moderator's restore statement) fails in the database as well.
-- Existing removals were all made by moderators: the default FALSE is right.
-- idx_comments_created, idx_votes_created: the admin comment listing and the
-- content analytics read comments and votes by creation time.
-- admin_actions: four content actions and the post and comment targets,
-- appended (never reordered; see 025_add_community_suspension). Role changes
-- use the existing user_role_changed action.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE posts: removed_by_admin and chk_posts_admin_removal.
--   2. SHOW CREATE TABLE comments: removed_by_admin, chk_comments_admin_removal
--      and idx_comments_created.
--   3. SHOW CREATE TABLE votes: idx_votes_created.
--   4. SHOW CREATE TABLE admin_actions: the four actions and two targets.
ALTER TABLE posts
  ADD COLUMN removed_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT chk_posts_admin_removal CHECK (removed_by_admin = FALSE OR removed_at IS NOT NULL);

ALTER TABLE comments
  ADD COLUMN removed_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT chk_comments_admin_removal CHECK (removed_by_admin = FALSE OR removed_at IS NOT NULL),
  ADD INDEX idx_comments_created (created_at, id);

ALTER TABLE votes
  ADD INDEX idx_votes_created (created_at);

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
    'comment_restored'
  ) NOT NULL,
  MODIFY COLUMN target_type ENUM('user', 'report', 'restriction', 'community', 'post', 'comment') NOT NULL;
