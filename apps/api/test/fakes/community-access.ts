import { COMMUNITY_ACCESS_SQL } from '../../src/common/community-visibility';

export interface FakeCommunityAccess {
  id: string;
  visibility?: 'public' | 'restricted' | 'private';
  creator_id?: string;
}

// Answers COMMUNITY_ACCESS_SQL (src/common/community-visibility.ts), the
// viewer's standing in one community (migration 038), or returns null for any
// other statement. Values: viewer, community id. A community not listed is
// unknown; one listed without a visibility is public. Membership is the
// creator, a subscriber or a moderator, as the real predicate has it.
export function answerCommunityAccess(
  sql: string,
  values: unknown[],
  communities: readonly FakeCommunityAccess[],
  isMember: (communityId: string, userId: string) => boolean = () => false,
): [unknown[], unknown[]] | null {
  if (sql !== COMMUNITY_ACCESS_SQL) {
    return null;
  }
  const [viewer, communityId] = values as [string | null, string];
  const community = communities.find((entry) => entry.id === communityId);
  if (!community) {
    return [[], []];
  }
  const member =
    viewer !== null &&
    (community.creator_id === viewer || isMember(communityId, viewer));
  return [
    [{ visibility: community.visibility ?? 'public', member: member ? 1 : 0 }],
    [],
  ];
}
