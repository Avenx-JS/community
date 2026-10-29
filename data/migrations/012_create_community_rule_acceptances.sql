-- Records which rule document version each user accepted, one row per
-- (user, document), so later versions never overwrite earlier acceptances.
-- community_id is always copied from the document inside the inserting
-- statement, never taken from a request. Acceptances cannot be withdrawn.
-- Grandfathers the version 1 documents backfilled by migration 009 (no other
-- documents can exist yet) for each community's current subscribers and its
-- creator; every later version requires explicit acceptance.
-- Not safely re-runnable: if the table exists but this version is unrecorded,
-- drop community_rule_acceptances and run this migration again.
CREATE TABLE community_rule_acceptances (
    user_id VARCHAR(36) NOT NULL,
    document_id VARCHAR(36) NOT NULL,
    community_id VARCHAR(36) NOT NULL,
    accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, document_id),
    INDEX idx_community_rule_acceptances_user_community (user_id, community_id, accepted_at),
    INDEX idx_community_rule_acceptances_document (document_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES community_rule_documents(id) ON DELETE CASCADE,
    FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
);

INSERT INTO community_rule_acceptances (user_id, document_id, community_id)
SELECT members.user_id, d.id, d.community_id
FROM community_rule_documents d
JOIN (
    SELECT s.user_id, s.community_id FROM community_subscriptions s
    UNION
    SELECT c.creator_id, c.id FROM communities c
) members ON members.community_id = d.community_id
WHERE d.version = 1;
