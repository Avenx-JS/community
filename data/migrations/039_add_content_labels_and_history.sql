-- Content labels, the reader's own view, and edit history.
-- posts.nsfw_set_by / posts.spoiler_set_by: NULL when the post carries no
-- such label, otherwise who set it. The author or a community moderator sets
-- a label; one set by a moderator only a moderator removes. Existing posts
-- carry none.
-- hidden_posts: posts an account hid from its own listings (GET /posts,
-- /feed, /communities/:name/posts); the permalink stays reachable.
-- saved_comments: an account's private comment bookmarks, the counterpart of
-- saved_posts: a row survives a removal or a hidden community (the list
-- omits it) and goes with the comment (CASCADE).
-- post_revisions / comment_revisions: each edit stores the version it
-- replaced, with the time that version was written (version_at) and the time
-- it was replaced (replaced_at). Edits made before this migration replaced
-- their text in place and left nothing to store: history starts here, and
-- GET .../revisions says when it is incomplete.
-- idx_votes_user_value: GET /users/me/upvoted and /downvoted, newest first.
--
-- Not safely re-runnable after partial application: MySQL DDL is not
-- transactional. After a failure, inspect in statement order and complete the
-- rest manually before recording this version:
--   1. SHOW CREATE TABLE posts: nsfw_set_by, spoiler_set_by.
--   2. SHOW TABLES: hidden_posts, saved_comments, post_revisions,
--      comment_revisions.
--   3. SHOW INDEX FROM votes: idx_votes_user_value.
ALTER TABLE posts
  ADD COLUMN nsfw_set_by ENUM('author', 'moderator') NULL DEFAULT NULL,
  ADD COLUMN spoiler_set_by ENUM('author', 'moderator') NULL DEFAULT NULL;

CREATE TABLE hidden_posts (
    user_id VARCHAR(36) NOT NULL,
    post_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, post_id),
    INDEX idx_hidden_posts_user_created (user_id, created_at, post_id),
    INDEX idx_hidden_posts_post (post_id),
    CONSTRAINT fk_hidden_posts_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_hidden_posts_post
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE saved_comments (
    user_id VARCHAR(36) NOT NULL,
    comment_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, comment_id),
    INDEX idx_saved_comments_user_created (user_id, created_at, comment_id),
    INDEX idx_saved_comments_comment (comment_id),
    CONSTRAINT fk_saved_comments_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_saved_comments_comment
        FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

CREATE TABLE post_revisions (
    id VARCHAR(36) PRIMARY KEY,
    post_id VARCHAR(36) NOT NULL,
    title VARCHAR(300) NOT NULL,
    content TEXT NULL,
    version_at TIMESTAMP NOT NULL,
    replaced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_post_revisions_post (post_id, replaced_at, id),
    CONSTRAINT fk_post_revisions_post
        FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE comment_revisions (
    id VARCHAR(36) PRIMARY KEY,
    comment_id VARCHAR(36) NOT NULL,
    content TEXT NOT NULL,
    version_at TIMESTAMP NOT NULL,
    replaced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_comment_revisions_comment (comment_id, replaced_at, id),
    CONSTRAINT fk_comment_revisions_comment
        FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

CREATE INDEX idx_votes_user_value ON votes (user_id, target_type, value, created_at, id);
