-- Creates immutable, versioned community rule documents with ordered rule
-- items, and backfills version 1 from the legacy communities.rules column,
-- which is retained. Published documents and their rules are never updated:
-- changing rules inserts a new document with the next per-community version.
-- content_hash must match hashCommunityRules() in
-- apps/api/src/communities/community-rules-hash.ts (see "Community rules" in
-- apps/api/README.md).
-- Not safely re-runnable after partial application. The backfill runs in one
-- transaction, so after a failure drop community_rules and then
-- community_rule_documents, if they exist, before running this migration again.
CREATE TABLE community_rule_documents (
    id VARCHAR(36) PRIMARY KEY,
    community_id VARCHAR(36) NOT NULL,
    version INT UNSIGNED NOT NULL,
    content_hash CHAR(64) NOT NULL,
    published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by VARCHAR(36) NULL,
    UNIQUE KEY unique_community_rule_version (community_id, version),
    INDEX idx_community_rule_documents_published_by (published_by),
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE community_rules (
    id VARCHAR(36) PRIMARY KEY,
    document_id VARCHAR(36) NOT NULL,
    position SMALLINT UNSIGNED NOT NULL,
    title VARCHAR(200) NOT NULL,
    body TEXT NULL,
    UNIQUE KEY unique_document_position (document_id, position),
    FOREIGN KEY (document_id) REFERENCES community_rule_documents(id) ON DELETE CASCADE
);

START TRANSACTION;

INSERT INTO community_rule_documents
    (id, community_id, version, content_hash, published_at, published_by)
SELECT
    UUID(),
    c.id,
    1,
    SHA2(CONCAT(
        '1', CHAR(10 USING utf8mb4),
        LENGTH('Community rules'), ':', 'Community rules', CHAR(10 USING utf8mb4),
        LENGTH(CONVERT(c.rules USING utf8mb4)), ':', CONVERT(c.rules USING utf8mb4)
    ), 256),
    COALESCE(c.created_at, CURRENT_TIMESTAMP),
    c.creator_id
FROM communities c
WHERE c.rules REGEXP '[^[:space:]]';

INSERT INTO community_rules (id, document_id, position, title, body)
SELECT UUID(), d.id, 1, 'Community rules', c.rules
FROM community_rule_documents d
JOIN communities c ON c.id = d.community_id
WHERE d.version = 1;

COMMIT;
