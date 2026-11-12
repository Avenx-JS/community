-- Routes reports about posts and comments to the moderators of the content's
-- community (GET /communities/:name/modqueue and /reports), beside the
-- platform administrators' queue, which is unchanged.
-- community_id is the community a report is routed to: set for a post or
-- comment target (the post's community, a comment's through its post), NULL
-- for a report about an account or a community, which only administrators
-- see. community_status is the community level's own review state, separate
-- from status, the administrators': 'open' until a moderator approves the
-- content or removes it; NULL where the report is not routed. Each level
-- decides independently, so a moderator's approval never closes the
-- administrators' review and the reverse.
-- community_reviewed_by and community_reviewed_at record the closing
-- moderator; ON DELETE SET NULL keeps the decision when that account goes.
-- The reporter is never shown either (GET /reports shows community_status).
-- community_id is ON DELETE SET NULL like every other reference of a report:
-- a report outlives what it is about.
-- idx_user_reports_modqueue serves the queue's grouping of open reports by
-- target and closing every open report of one target; idx_user_reports_community
-- the report listing by state and age.
-- Backfill: existing post and comment reports get their community. Those
-- still open for administrators (open or under_review, not withdrawn) become
-- 'open' in the community queue too; reports already closed or withdrawn keep
-- community_status NULL: they predate the queue, and no moderator decided them.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE user_reports: the four columns and both foreign keys
--      (all added by the first statement, or none).
--   2. The three backfill UPDATE statements are idempotent and may be re-run.
--   3. SHOW INDEX FROM user_reports: idx_user_reports_modqueue, then
--      idx_user_reports_community.
--   4. SHOW CREATE TABLE community_moderation_actions: report_approved and
--      report_removed appended to action.
ALTER TABLE user_reports
  ADD COLUMN community_id VARCHAR(36) NULL,
  ADD COLUMN community_status ENUM('open', 'approved', 'removed') NULL,
  ADD COLUMN community_reviewed_by VARCHAR(36) NULL,
  ADD COLUMN community_reviewed_at TIMESTAMP NULL DEFAULT NULL,
  ADD CONSTRAINT fk_user_reports_community FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_user_reports_community_reviewed_by FOREIGN KEY (community_reviewed_by) REFERENCES users(id) ON DELETE SET NULL;

UPDATE user_reports
  JOIN posts ON user_reports.target_type = 'post' AND posts.id = user_reports.target_id
  SET user_reports.community_id = posts.community_id;

UPDATE user_reports
  JOIN comments ON user_reports.target_type = 'comment' AND comments.id = user_reports.target_id
  JOIN posts ON posts.id = comments.post_id
  SET user_reports.community_id = posts.community_id;

UPDATE user_reports
  SET community_status = 'open'
  WHERE community_id IS NOT NULL
    AND status IN ('open', 'under_review')
    AND withdrawn_at IS NULL;

CREATE INDEX idx_user_reports_modqueue
  ON user_reports (community_id, community_status, target_type, target_id);
CREATE INDEX idx_user_reports_community
  ON user_reports (community_id, community_status, created_at);

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
    'report_removed'
  ) NOT NULL;
