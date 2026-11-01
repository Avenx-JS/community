-- Generalises user_reports from "a report about an account" to "a report
-- about a target": target_type + target_id name what was reported (a user,
-- post, comment or community). The table keeps its name; see "Reports" in
-- apps/api/README.md.
--
-- target_id has no foreign key: it is polymorphic, like votes.target_id, and a
-- report must outlive the content it names. reported_user_id stays as the
-- account the report concerns (the author for content targets, NULL for
-- communities); it becomes nullable and its foreign key changes from
-- ON DELETE CASCADE to ON DELETE SET NULL, so deleting an account no longer
-- deletes reports about it. target_author_id records a content target's
-- author at submission time. context_type/context_id are unchanged and remain
-- supporting evidence.
--
-- The DEFAULT 'user' on target_type only lets the column be added NOT NULL to
-- a populated table; every writer sets it explicitly.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional and the statements below run in order. To complete a partial
-- run by hand, check each step's effect with SHOW CREATE TABLE user_reports
-- and resume at the first step that has not taken effect:
--   1. target_type, target_id and target_author_id exist, with
--      fk_user_reports_target_author;
--   2. the backfill: SELECT COUNT(*) FROM user_reports WHERE target_id IS NULL
--      returns 0. Never run the step 4 MODIFY before this is 0, or it fails
--      (strict mode) or turns NULL ids into empty strings;
--   3. the reported_user_id foreign key with ON DELETE CASCADE is gone;
--   4. target_id is NOT NULL and reported_user_id is NULL-able;
--   5. fk_user_reports_reported_user exists with ON DELETE SET NULL;
--   6. idx_user_reports_target and idx_user_reports_target_type_created exist.
ALTER TABLE user_reports
  ADD COLUMN target_type ENUM('user', 'post', 'comment', 'community') NOT NULL DEFAULT 'user',
  ADD COLUMN target_id VARCHAR(36) NULL,
  ADD COLUMN target_author_id VARCHAR(36) NULL,
  ADD CONSTRAINT fk_user_reports_target_author
    FOREIGN KEY (target_author_id) REFERENCES users(id) ON DELETE SET NULL;

-- Every existing row is a user report; the context pair, where present, is the
-- evidence it always was and is left untouched.
UPDATE user_reports SET target_type = 'user', target_id = reported_user_id;

-- The original foreign key was declared without a name, so look it up.
SET @reported_user_fk = (
  SELECT constraint_name
  FROM information_schema.key_column_usage
  WHERE table_schema = DATABASE()
    AND table_name = 'user_reports'
    AND column_name = 'reported_user_id'
    AND referenced_table_name = 'users'
);
SET @drop_reported_user_fk = CONCAT(
  'ALTER TABLE user_reports DROP FOREIGN KEY ', @reported_user_fk
);
PREPARE drop_reported_user_fk FROM @drop_reported_user_fk;
EXECUTE drop_reported_user_fk;
DEALLOCATE PREPARE drop_reported_user_fk;

ALTER TABLE user_reports
  MODIFY COLUMN target_id VARCHAR(36) NOT NULL,
  MODIFY COLUMN reported_user_id VARCHAR(36) NULL;

ALTER TABLE user_reports
  ADD CONSTRAINT fk_user_reports_reported_user
    FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_user_reports_target
  ON user_reports (target_type, target_id, status);

CREATE INDEX idx_user_reports_target_type_created
  ON user_reports (target_type, created_at);
