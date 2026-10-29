-- Drops the legacy communities.rules column. Versioned rule documents
-- (migration 009, read and written by /communities/:name/rules) are the only
-- source of community rules from here on.
--
-- IRREVERSIBLE. After this runs, the legacy text survives only as the
-- version 1 documents created by migrations 009 and 013. Take a backup first.
--
-- ORDERING. This must run after 009 (initial backfill) and 013 (catch-up
-- backfill) have been applied, which the runner's ascending numeric order
-- enforces. Never renumber this file to sort before either of them: that
-- would destroy the legacy rules before they are copied.
--
-- GUARD. The statements below refuse to drop the column while any community
-- has non-blank legacy rules without a version 1 document holding exactly that
-- text as its single rule. The count is inserted into a temporary table with
-- CHECK (unmigrated = 0), so a non-zero count fails with a check-constraint
-- error (MySQL 8.0.16 or later), the ALTER never runs, and the version is not
-- recorded. The same query is documented under "Community rules" in
-- apps/api/README.md for checking by hand and for listing the communities
-- that block the drop.
--
-- Not re-runnable after success: the column no longer exists, so the guard
-- query fails. If the guard fails, nothing has changed; resolve the listed
-- communities and run the migration again.
DROP TEMPORARY TABLE IF EXISTS communities_rules_drop_guard;
CREATE TEMPORARY TABLE communities_rules_drop_guard (
    unmigrated INT NOT NULL,
    CONSTRAINT legacy_rules_have_documents CHECK (unmigrated = 0)
);

INSERT INTO communities_rules_drop_guard (unmigrated)
SELECT COUNT(*)
FROM communities c
WHERE c.rules REGEXP '[^[:space:]]'
  AND NOT EXISTS (
      SELECT 1
      FROM community_rule_documents d
      JOIN community_rules r ON r.document_id = d.id
      WHERE d.community_id = c.id
        AND d.version = 1
        AND r.position = 1
        AND CAST(CONVERT(r.body USING utf8mb4) AS BINARY)
            = CAST(CONVERT(c.rules USING utf8mb4) AS BINARY)
        AND NOT EXISTS (
            SELECT 1 FROM community_rules other
            WHERE other.document_id = d.id AND other.position <> 1
        )
  );

DROP TEMPORARY TABLE communities_rules_drop_guard;

ALTER TABLE communities DROP COLUMN rules;
