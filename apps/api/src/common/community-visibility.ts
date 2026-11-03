// SQL expression that is true when the community identified by
// communityIdColumn has not been deleted. Community deletion is a soft delete
// (communities.deleted_at), so every read of community-scoped content must
// apply this or the content of a deleted community stays reachable. No
// placeholders, so it can be appended to any WHERE clause.
export function activeCommunitySql(communityIdColumn: string): string {
  return `EXISTS (
         SELECT 1 FROM communities
         WHERE communities.id = ${communityIdColumn}
           AND communities.deleted_at IS NULL
       )`;
}
