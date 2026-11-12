-- Community settings, membership requests, moderator invitations, flairs and
-- mutes.
-- communities.visibility: public (anyone reads and joins), restricted
-- (anyone reads; posting needs membership, joining an approved request),
-- private (content, members and moderators only for members; joining needs
-- an approved request). Every existing community stays public.
-- communities.nsfw: content shown in cross-community listings only to
-- viewers whose user_preferences.show_nsfw is on.
-- communities.allowed_post_types: which of text, link and media POST /posts
-- accepts; all three for every existing community.
-- community_join_requests: one row per community and account; status keeps
-- the decision, so a denied request is not silently repeated.
-- community_moderator_invites: a pending invitation, deleted when accepted,
-- declined or revoked. Nobody becomes a moderator without accepting one.
-- community_flairs: a community's post and user flairs; mod_only ones only
-- moderators may assign. posts.flair_id and community_user_flairs.flair_id
-- reference them; deleting a flair clears it from posts (SET NULL) and
-- removes it from members (CASCADE).
-- community_mutes: communities an account hides from its feed, search and
-- discovery.
-- community_moderation_actions.action gains the invitation and join-request
-- decisions. Settings changes are community_updated with their field names.
-- Every new table cascades from users and communities; account deletion
-- removes the account's rows explicitly, since anonymising never fires the
-- cascade.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE communities: visibility, nsfw, allowed_post_types.
--   2. SHOW TABLES: community_join_requests, community_moderator_invites,
--      community_flairs, community_user_flairs, community_mutes.
--   3. SHOW CREATE TABLE posts: flair_id and fk_posts_flair.
--   4. SHOW CREATE TABLE community_moderation_actions: the five new actions.
ALTER TABLE communities
  ADD COLUMN visibility ENUM('public', 'restricted', 'private') NOT NULL DEFAULT 'public',
  ADD COLUMN nsfw BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN allowed_post_types SET('text', 'link', 'media') NOT NULL DEFAULT 'text,link,media';

CREATE TABLE community_join_requests (
    community_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    status ENUM('pending', 'approved', 'denied') NOT NULL DEFAULT 'pending',
    message VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at TIMESTAMP NULL DEFAULT NULL,
    decided_by VARCHAR(36) NULL,
    PRIMARY KEY (community_id, user_id),
    INDEX idx_community_join_requests_queue (community_id, status, created_at),
    INDEX idx_community_join_requests_user (user_id),
    CONSTRAINT fk_community_join_requests_community
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    CONSTRAINT fk_community_join_requests_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_community_join_requests_decided_by
        FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE community_moderator_invites (
    community_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    invited_by VARCHAR(36) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (community_id, user_id),
    INDEX idx_community_moderator_invites_user (user_id, created_at),
    CONSTRAINT fk_community_moderator_invites_community
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    CONSTRAINT fk_community_moderator_invites_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_community_moderator_invites_invited_by
        FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE community_flairs (
    id VARCHAR(36) PRIMARY KEY,
    community_id VARCHAR(36) NOT NULL,
    kind ENUM('post', 'user') NOT NULL,
    text VARCHAR(64) NOT NULL,
    background_color CHAR(7) NULL,
    mod_only BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_community_flairs_text (community_id, kind, text),
    CONSTRAINT fk_community_flairs_community
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
);

ALTER TABLE posts
  ADD COLUMN flair_id VARCHAR(36) NULL,
  ADD CONSTRAINT fk_posts_flair FOREIGN KEY (flair_id) REFERENCES community_flairs(id) ON DELETE SET NULL;

CREATE TABLE community_user_flairs (
    community_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    flair_id VARCHAR(36) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (community_id, user_id),
    INDEX idx_community_user_flairs_flair (flair_id),
    CONSTRAINT fk_community_user_flairs_community
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE,
    CONSTRAINT fk_community_user_flairs_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_community_user_flairs_flair
        FOREIGN KEY (flair_id) REFERENCES community_flairs(id) ON DELETE CASCADE
);

CREATE TABLE community_mutes (
    user_id VARCHAR(36) NOT NULL,
    community_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, community_id),
    INDEX idx_community_mutes_community (community_id),
    CONSTRAINT fk_community_mutes_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_community_mutes_community
        FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE CASCADE
);

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
    'join_request_denied'
  ) NOT NULL;
