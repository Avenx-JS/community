-- Catch-up for communities created after migration 009 ran but before
-- POST /communities stopped accepting the legacy rules field: their
-- communities.rules text never became a rule document. For every community
-- whose legacy rules contain a non-whitespace character and that has no rule
-- document at all, this repeats exactly what 009 and 012 did for older
-- communities: a version 1 document dated communities.created_at, attributed
-- to the creator, with one rule titled 'Community rules' holding the legacy
-- text verbatim, hashed with the same expression as 009 (pinned by
-- community-rules-hash.spec.ts), and an acceptance of it for the community's
-- current subscribers and its creator. Communities that already have any
-- document are left alone; 014 refuses to drop the column while their legacy
-- text differs from their version 1 document.
-- Safe to re-run: every insert skips rows that already exist, so a second run
-- after success inserts nothing, and the transaction leaves nothing behind
-- after a failure.
DROP TEMPORARY TABLE IF EXISTS late_rule_backfill;
CREATE TEMPORARY TABLE late_rule_backfill (
    community_id VARCHAR(36) PRIMARY KEY,
    document_id VARCHAR(36) NOT NULL
);

START TRANSACTION;

INSERT INTO late_rule_backfill (community_id, document_id)
SELECT c.id, UUID()
FROM communities c
WHERE c.rules REGEXP '[^[:space:]]'
  AND NOT EXISTS (
      SELECT 1 FROM community_rule_documents d WHERE d.community_id = c.id
  );

INSERT INTO community_rule_documents
    (id, community_id, version, content_hash, published_at, published_by)
SELECT
    b.document_id,
    c.id,
    1,
    SHA2(CONCAT(
        '1', CHAR(10 USING utf8mb4),
        LENGTH('Community rules'), ':', 'Community rules', CHAR(10 USING utf8mb4),
        LENGTH(CONVERT(c.rules USING utf8mb4)), ':', CONVERT(c.rules USING utf8mb4)
    ), 256),
    COALESCE(c.created_at, CURRENT_TIMESTAMP),
    c.creator_id
FROM late_rule_backfill b
JOIN communities c ON c.id = b.community_id;

INSERT INTO community_rules (id, document_id, position, title, body)
SELECT UUID(), b.document_id, 1, 'Community rules', c.rules
FROM late_rule_backfill b
JOIN communities c ON c.id = b.community_id;

INSERT INTO community_rule_acceptances (user_id, document_id, community_id)
SELECT members.user_id, b.document_id, b.community_id
FROM late_rule_backfill b
JOIN (
    SELECT s.user_id, s.community_id FROM community_subscriptions s
    UNION
    SELECT c.creator_id, c.id FROM communities c
) members ON members.community_id = b.community_id;

COMMIT;

DROP TEMPORARY TABLE late_rule_backfill;
