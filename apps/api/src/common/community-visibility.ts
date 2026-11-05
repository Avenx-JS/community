// SQL expression that is true when the community identified by
// communityIdColumn has not been deleted. Community deletion is a soft delete
// (communities.deleted_at), so every read of community-scoped content must
// apply this or the content of a deleted community stays reachable. No
// placeholders, so it can be appended to any WHERE clause.
export function activeCommunitySql(communityIdColumn: string): string {
  return activeCommunityExists(communityIdColumn, '');
}

// As activeCommunitySql, and also false for a suspended community
// (communities.suspended_at, migration 025). Only the public author listings
// (GET /users/:username/...) apply it so far: suspension is not enforced on
// the other reads yet, and each must add it when it is.
export function listedCommunitySql(communityIdColumn: string): string {
  return activeCommunityExists(
    communityIdColumn,
    '\n           AND communities.suspended_at IS NULL',
  );
}

function activeCommunityExists(
  communityIdColumn: string,
  extra: string,
): string {
  return `EXISTS (
         SELECT 1 FROM communities
         WHERE communities.id = ${communityIdColumn}
           AND communities.deleted_at IS NULL${extra}
       )`;
}
