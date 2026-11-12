// The one definition of "this community is publicly there": neither
// soft-deleted by its creator (deleted_at) nor suspended by a platform
// administrator (suspended_at). Every public read and every write applies it,
// so a call site cannot honour one hidden state and miss the other, and the
// two states are indistinguishable from outside: both are a 404 or an
// omission. Only the /admin routes, which must see hidden communities, do
// not use it.
const HIDDEN_STATE_COLUMNS = ['deleted_at', 'suspended_at'] as const;

const visibleOver = (qualify: (column: string) => string) =>
  HIDDEN_STATE_COLUMNS.map((column) => `${qualify(column)} IS NULL`).join(
    ' AND ',
  );

// Unqualified, for a statement over communities alone.
export const COMMUNITY_VISIBLE_PREDICATE = visibleOver((column) => column);

// The same predicate over a communities alias, e.g. visibleCommunityColumnsSql('c').
export function visibleCommunityColumnsSql(alias: string): string {
  return visibleOver((column) => `${alias}.${column}`);
}

// The same predicate for content that names its community by id: true when
// the community identified by communityIdColumn is visible. No placeholders,
// so it can be appended to any WHERE clause.
export function visibleCommunitySql(communityIdColumn: string): string {
  return `EXISTS (
         SELECT 1 FROM communities
         WHERE communities.id = ${communityIdColumn}
           AND ${visibleCommunityColumnsSql('communities')}
       )`;
}

// Community settings (migration 038). Visibility above says whether a
// community is there at all; these say whether a given viewer may read it.
// A private community's content, members and moderators are for its members
// only: its creator, its subscribers and its moderators. Restricted and
// public communities are readable by everyone, signed in or not.
export type CommunityVisibility = 'public' | 'restricted' | 'private';
export const COMMUNITY_VISIBILITIES: readonly CommunityVisibility[] = [
  'public',
  'restricted',
  'private',
];

// True when the account in viewerColumn is a member of the community aliased
// communityAlias. No placeholders.
export function communityMemberSql(
  communityAlias: string,
  viewerColumn: string,
): string {
  return `(${communityAlias}.creator_id = ${viewerColumn}
             OR EXISTS (
               SELECT 1 FROM community_subscriptions member_subscription
               WHERE member_subscription.community_id = ${communityAlias}.id
                 AND member_subscription.user_id = ${viewerColumn}
             )
             OR EXISTS (
               SELECT 1 FROM community_moderators member_moderator
               WHERE member_moderator.community_id = ${communityAlias}.id
                 AND member_moderator.user_id = ${viewerColumn}
             ))`;
}

// What a cross-community listing hides on top of private communities:
// nsfw ones unless the viewer's show_nsfw preference is on (an anonymous
// viewer has none, so never), and muted ones (the viewer's community_mutes).
export interface ReadableCommunityOptions {
  nsfw?: boolean;
  muted?: boolean;
}

// The viewer-aware form of visibleCommunitySql, for every read of content:
// true when the community identified by communityIdColumn is visible and the
// viewer may read it. Exactly ONE placeholder, the viewer's id or null for an
// anonymous request, bound once through a derived table however many checks
// use it. Evaluated per statement, so making a community private takes its
// content from non-members on their next request.
export function readableCommunitySql(
  communityIdColumn: string,
  options: ReadableCommunityOptions = {},
): string {
  const nsfw = options.nsfw
    ? `
           AND (communities.nsfw = FALSE OR EXISTS (
             SELECT 1 FROM user_preferences viewer_preferences
             WHERE viewer_preferences.user_id = viewer.id
               AND viewer_preferences.show_nsfw = TRUE
           ))`
    : '';
  const muted = options.muted
    ? `
           AND NOT EXISTS (
             SELECT 1 FROM community_mutes viewer_mute
             WHERE viewer_mute.community_id = communities.id
               AND viewer_mute.user_id = viewer.id
           )`
    : '';
  return `EXISTS (
         SELECT 1 FROM communities
         CROSS JOIN (SELECT CAST(? AS CHAR(36)) AS id) viewer
         WHERE communities.id = ${communityIdColumn}
           AND ${visibleCommunityColumnsSql('communities')}
           AND (communities.visibility <> 'private' OR ${communityMemberSql('communities', 'viewer.id')})${nsfw}${muted}
       )`;
}

// The visibility of a community, and whether the viewer (one placeholder,
// after the id) is a member. For the routes of one community that answer a
// non-member of a private one 403 rather than an empty page.
export const COMMUNITY_ACCESS_SQL = `SELECT communities.visibility, ${communityMemberSql('communities', 'viewer.id')} AS member
       FROM communities
       CROSS JOIN (SELECT CAST(? AS CHAR(36)) AS id) viewer
       WHERE communities.id = ? AND ${visibleCommunityColumnsSql('communities')}
       LIMIT 1`;

export const PRIVATE_COMMUNITY_REASON = 'private_community';
export const PRIVATE_COMMUNITY_MESSAGE =
  'This community is private: only its members can see its content';

// For listings of communities themselves (the directory, search, discovery):
// private ones are listed, since their name and description are public, but
// nsfw ones only for a viewer who opted in, and with muted, not the viewer's
// muted ones. Exactly ONE placeholder, the viewer's id or null.
export function listedCommunitySql(
  communityAlias: string,
  options: { muted?: boolean } = {},
): string {
  const muted = options.muted
    ? `
           AND NOT EXISTS (
             SELECT 1 FROM community_mutes viewer_mute
             WHERE viewer_mute.community_id = ${communityAlias}.id
               AND viewer_mute.user_id = viewer.id
           )`
    : '';
  return `EXISTS (
         SELECT 1 FROM (SELECT CAST(? AS CHAR(36)) AS id) viewer
         WHERE (${communityAlias}.nsfw = FALSE OR EXISTS (
             SELECT 1 FROM user_preferences viewer_preferences
             WHERE viewer_preferences.user_id = viewer.id
               AND viewer_preferences.show_nsfw = TRUE
           ))${muted}
       )`;
}
