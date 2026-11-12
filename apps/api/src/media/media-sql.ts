import {
  readableCommunitySql,
  visibleCommunityColumnsSql,
} from '../common/community-visibility';

// The statements behind media's lifecycle, defined once (migration 035).

export const MEDIA_COLUMNS =
  'media.id, media.uploader_id, media.purpose, media.kind, media.mime_type, media.size_bytes, media.width, media.height, media.storage_key, media.created_at';

// A file is in use while any row references it. One EXISTS per reference,
// each a probe of that column's unique index.
export const MEDIA_REFERENCED_SQL = `(EXISTS (SELECT 1 FROM posts WHERE posts.media_id = media.id)
      OR EXISTS (SELECT 1 FROM users WHERE users.avatar_media_id = media.id)
      OR EXISTS (SELECT 1 FROM communities WHERE communities.icon_media_id = media.id)
      OR EXISTS (SELECT 1 FROM communities WHERE communities.banner_media_id = media.id))`;

// Who may read a file through GET /media/:id and GET /media/:id/file: the
// places that show it decide, so a file is exactly as visible as the content
// it belongs to. A post's file while the post is listed (not removed, its
// community visible); an avatar while the account exists; an icon or banner
// while the community is visible; and the uploader's own file while it is
// not released, so an upload can be previewed before it is posted. A
// released file is visible to no one, and a post's file in a private
// community only to its members. Bound to [media id, viewer id or null,
// viewer id or null].
export const VISIBLE_MEDIA_SQL = `SELECT ${MEDIA_COLUMNS}
       FROM media
       WHERE media.id = ? AND media.released_at IS NULL
         AND (
           EXISTS (
             SELECT 1 FROM posts
             WHERE posts.media_id = media.id AND posts.removed_at IS NULL
               AND ${readableCommunitySql('posts.community_id')}
           )
           OR EXISTS (
             SELECT 1 FROM users
             WHERE users.avatar_media_id = media.id AND users.deleted_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM communities
             WHERE communities.icon_media_id = media.id
               AND ${visibleCommunityColumnsSql('communities')}
           )
           OR EXISTS (
             SELECT 1 FROM communities
             WHERE communities.banner_media_id = media.id
               AND ${visibleCommunityColumnsSql('communities')}
           )
           OR media.uploader_id = ?
         )
       LIMIT 1`;

export const INSERT_MEDIA_SQL =
  'INSERT INTO media (id, uploader_id, purpose, kind, mime_type, size_bytes, width, height, storage_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';

// The uploader's unattached post uploads, counted for MEDIA_PENDING_MAX
// under the lock of their users row, so two concurrent uploads at the cap
// cannot both pass. Bound to [uploader].
export const PENDING_UPLOADS_SQL = `SELECT COUNT(*) AS pending FROM media
       WHERE media.uploader_id = ? AND media.released_at IS NULL AND media.purpose = 'post'
         AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.media_id = media.id)`;

export const LOCK_UPLOADER_SQL =
  'SELECT id FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE';

// DELETE /media/:id: the uploader's own, unattached, unreleased post upload.
// Locked, so a concurrent POST /posts attaching it waits. Bound to [id].
export const LOCK_OWN_UPLOAD_SQL = `SELECT media.id, media.uploader_id, media.purpose, media.released_at,
         EXISTS (SELECT 1 FROM posts WHERE posts.media_id = media.id) AS attached
       FROM media WHERE media.id = ? LIMIT 1 FOR UPDATE`;

export const RELEASE_MEDIA_SQL =
  'UPDATE media SET released_at = UTC_TIMESTAMP() WHERE id = ? AND released_at IS NULL';

// Run in the deleting transaction, before the row that references the file
// goes or forgets it. Each is bound to the owner's id.
export const RELEASE_POST_MEDIA_SQL =
  'UPDATE media SET released_at = UTC_TIMESTAMP() WHERE released_at IS NULL AND id = (SELECT media_id FROM posts WHERE id = ?)';
export const RELEASE_COMMUNITY_MEDIA_SQL = [
  'UPDATE media SET released_at = UTC_TIMESTAMP() WHERE released_at IS NULL AND id = (SELECT icon_media_id FROM communities WHERE id = ?)',
  'UPDATE media SET released_at = UTC_TIMESTAMP() WHERE released_at IS NULL AND id = (SELECT banner_media_id FROM communities WHERE id = ?)',
  'UPDATE communities SET icon_media_id = NULL, banner_media_id = NULL WHERE id = ?',
] as const;
// The avatar, and uploads never attached to a post. Files in the account's
// posts stay with those posts, which account deletion keeps.
export const RELEASE_ACCOUNT_MEDIA_SQL = [
  'UPDATE media SET released_at = UTC_TIMESTAMP() WHERE released_at IS NULL AND id = (SELECT avatar_media_id FROM users WHERE id = ?)',
  'UPDATE users SET avatar_media_id = NULL WHERE id = ?',
  `UPDATE media SET released_at = UTC_TIMESTAMP()
       WHERE media.uploader_id = ? AND media.released_at IS NULL AND media.purpose = 'post'
         AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.media_id = media.id)`,
] as const;

// The sweep, step 1: uploads still unreferenced after the pending window
// (MEDIA_PENDING_TTL_HOURS) are released. created_at is compared with
// CURRENT_TIMESTAMP, the clock its default comes from. Bound to [hours].
export const RELEASE_STALE_UPLOADS_SQL = `UPDATE media SET released_at = UTC_TIMESTAMP()
       WHERE media.released_at IS NULL
         AND media.created_at < CURRENT_TIMESTAMP - INTERVAL ? HOUR
         AND NOT ${MEDIA_REFERENCED_SQL}`;

// Step 2: released, unreferenced files, oldest first. Bound to [batch size].
export const RELEASED_MEDIA_SQL = `SELECT media.id, media.storage_key FROM media
       WHERE media.released_at IS NOT NULL AND NOT ${MEDIA_REFERENCED_SQL}
       ORDER BY media.released_at, media.id
       LIMIT ?`;

// Step 3, after the object is deleted. Guarded again, so a row is only ever
// deleted while released and unreferenced. Bound to [id].
export const DELETE_RELEASED_MEDIA_SQL = `DELETE FROM media
       WHERE media.id = ? AND media.released_at IS NOT NULL AND NOT ${MEDIA_REFERENCED_SQL}`;
