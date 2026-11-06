-- Creates saved_posts: a user's private bookmarks, for POST and DELETE
-- /posts/:id/save and GET /users/me/saved-posts.
-- The composite primary key (user_id, post_id) allows one row per user and
-- post, so a duplicate save is impossible by construction and the save is an
-- idempotent upsert that never refreshes created_at, the listing's order key.
-- idx_saved_posts_user_created (user_id, created_at, post_id) is the
-- (filter, created_at, tiebreaker) shape: it serves the newest-saved-first
-- listing in either direction without a filesort. The primary key's leading
-- user_id serves the filter but not the order.
-- Both foreign keys cascade: a save means nothing without its user or its
-- post. A post removed by moderation is not deleted, so its saves remain and
-- the listing filters removed content itself; a restored post reappears.
-- Saves are private: no route exposes another user's saves or a save count.
--
-- Not safely re-runnable after partial application: CREATE TABLE fails if the
-- table exists. After a failure, check SHOW CREATE TABLE saved_posts for the
-- primary key, idx_saved_posts_user_created and both foreign keys before
-- recording this version.
CREATE TABLE saved_posts (
    user_id VARCHAR(36) NOT NULL,
    post_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, post_id),
    INDEX idx_saved_posts_user_created (user_id, created_at, post_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
