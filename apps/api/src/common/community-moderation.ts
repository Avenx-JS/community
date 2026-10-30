// SQL expression that is true when the user bound to both placeholders created
// or moderates the community identified by communityIdColumn. Used inside the
// locking reads of PostsService.remove and CommentsService.remove: InnoDB does
// not lock rows read by a nested subquery, so only the content row is locked.
export function canModerateCommunitySql(communityIdColumn: string): string {
  return `EXISTS (
         SELECT 1 FROM communities
         WHERE communities.id = ${communityIdColumn}
           AND (
             communities.creator_id = ? OR EXISTS (
               SELECT 1 FROM community_moderators
               WHERE community_moderators.community_id = communities.id
                 AND community_moderators.user_id = ?
             )
           )
       )`;
}

// mysql2 returns an EXISTS column as 0/1, or as a string under some casts.
export function isSqlTrue(value: number | string | boolean): boolean {
  return value === true || Number(value) === 1;
}
