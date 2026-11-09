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
