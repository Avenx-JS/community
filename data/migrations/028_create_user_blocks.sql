-- Creates user_blocks: one user's private block of another, for GET
-- /users/me/blocked and POST and DELETE /users/me/blocked/:username.
-- This is the relationship only. Nothing reads it to change behaviour yet: what
-- a block prevents, and whether its effects are symmetric, is decided by the
-- enforcement work. The row is directional, blocker_id blocked blocked_id, so
-- it keeps who initiated it whichever way that goes.
-- The composite primary key (blocker_id, blocked_id) allows one row per pair,
-- so a duplicate block is impossible by construction and the write is an
-- idempotent upsert that never refreshes created_at, the listing's order key.
-- idx_user_blocks_blocker_created (blocker_id, created_at, blocked_id) is the
-- (filter, created_at, tiebreaker) shape: it serves the newest-first listing
-- without a filesort.
-- idx_user_blocks_blocked (blocked_id, blocker_id) serves "who has blocked this
-- user", which the primary key cannot. Enforcement needs both directions;
-- declaring it here means that work needs no migration of its own.
-- chk_user_blocks_not_self refuses a self-block. It can be a CHECK because
-- MySQL allows one next to ON DELETE CASCADE, which does not write the column;
-- it refuses one next to ON DELETE SET NULL or ON UPDATE CASCADE or SET NULL
-- (error 3823), which is why the rules in check-trigger-rules.ts are triggers.
-- Both foreign keys cascade. Account deletion anonymises the users row rather
-- than deleting it, so AccountDeletionService removes these rows itself.
-- No reason column: a block is private and needs no justification.
--
-- Not safely re-runnable after partial application: CREATE TABLE fails if the
-- table exists. After a failure, check SHOW CREATE TABLE user_blocks for the
-- primary key, both indexes, chk_user_blocks_not_self and both foreign keys
-- before recording this version.
CREATE TABLE user_blocks (
    blocker_id VARCHAR(36) NOT NULL,
    blocked_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id),
    INDEX idx_user_blocks_blocker_created (blocker_id, created_at, blocked_id),
    INDEX idx_user_blocks_blocked (blocked_id, blocker_id),
    CONSTRAINT chk_user_blocks_not_self CHECK (blocker_id <> blocked_id),
    FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
);
