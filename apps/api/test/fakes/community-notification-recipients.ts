// The membership/preference matrix for community-activity notifications,
// shared by the recipient-contract test (MySQL), the community_post fan-out
// test (MySQL) and the posts e2e fake, so they cannot disagree about who is
// eligible.
export const recipientFixture = {
  communityId: 'c1',
  author: 'post-author',
  users: [
    'post-author',
    'member-default',
    'member-on',
    'member-off',
    'outsider-on',
    'other-community-member',
  ],
  communities: ['c1', 'c2'],
  // [user_id, community_id]
  subscriptions: [
    ['post-author', 'c1'],
    ['member-default', 'c1'],
    ['member-on', 'c1'],
    ['member-off', 'c1'],
    ['other-community-member', 'c2'],
  ] as Array<[string, string]>,
  // [user_id, community_id, new_posts]
  preferences: [
    ['member-on', 'c1', true],
    ['member-off', 'c1', false],
    ['outsider-on', 'c1', true],
    ['other-community-member', 'c1', true],
  ] as Array<[string, string, boolean]>,
  // What the contract selects for c1, sorted: members unless muted, a missing
  // row counting as enabled, never a non-member.
  eligible: ['member-default', 'member-on', 'post-author'],
  // What a post by the author in c1 notifies.
  notified: ['member-default', 'member-on'],
};

// In-memory evaluation of COMMUNITY_NEW_POST_RECIPIENTS_SQL, for fakes that
// cannot run SQL. The MySQL tests prove it agrees with the real statement.
export function eligibleRecipients(
  subscriptions: ReadonlyArray<[string, string]>,
  preferences: ReadonlyArray<[string, string, boolean]>,
  communityId: string,
): string[] {
  return subscriptions
    .filter(([, community]) => community === communityId)
    .map(([userId]) => userId)
    .filter(
      (userId) =>
        preferences.find(
          ([user, community]) => user === userId && community === communityId,
        )?.[2] ?? true,
    );
}
