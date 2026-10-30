// In-memory community rule documents and acceptances, answering exactly the
// statements CommunityRuleAcceptanceService and the rules routes send. Shared
// by the acceptance unit tests and the participation e2e fakes so they agree
// on what "accepted" means.

interface RuleDocument {
  id: string;
  community_id: string;
  version: number;
}

interface RuleAcceptance {
  user_id: string;
  document_id: string;
  community_id: string;
  accepted_at: Date;
}

export interface RulesStore {
  communities: Map<string, { name: string; creator_id: string }>;
  documents: RuleDocument[];
  acceptances: RuleAcceptance[];
  // Every statement the store answered, in order.
  statements: string[];
  // Publishes the next version for a community and returns it.
  publish(communityId: string): number;
  // Accepts the community's current version for a user.
  accept(userId: string, communityId: string): void;
  // Answers a statement it owns, or returns undefined for the caller's fake.
  handle(sql: string, values: unknown[]): [unknown, unknown] | undefined;
}

export function createRulesStore(
  communities: Record<string, { name: string; creator_id: string }> = {},
): RulesStore {
  const store: RulesStore = {
    communities: new Map(Object.entries(communities)),
    documents: [],
    acceptances: [],
    statements: [],
    publish(communityId) {
      const version =
        Math.max(
          0,
          ...store.documents
            .filter((document) => document.community_id === communityId)
            .map((document) => document.version),
        ) + 1;
      store.documents.push({
        id: `${communityId}-rules-v${version}`,
        community_id: communityId,
        version,
      });
      return version;
    },
    accept(userId, communityId) {
      const current = currentDocument(communityId);
      if (!current) {
        throw new Error(`${communityId} has no published rules`);
      }
      store.acceptances.push({
        user_id: userId,
        document_id: current.id,
        community_id: communityId,
        accepted_at: new Date('2026-10-30T08:00:00.000Z'),
      });
    },
    handle(sql, values) {
      const answer = respond(sql, values);
      if (answer !== undefined) {
        store.statements.push(sql);
      }
      return answer;
    },
  };

  function currentDocument(communityId: string): RuleDocument | undefined {
    return store.documents
      .filter((document) => document.community_id === communityId)
      .sort((left, right) => right.version - left.version)[0];
  }

  function respond(
    sql: string,
    values: unknown[],
  ): [unknown, unknown] | undefined {
    // CommunityRuleAcceptanceService.getState
    if (sql.includes('LEFT JOIN community_rule_acceptances a')) {
      const [userId, communityId] = values as [string, string];
      const current = currentDocument(communityId);
      if (!current) {
        return [[], []];
      }
      const accepted = store.acceptances.find(
        (row) => row.user_id === userId && row.document_id === current.id,
      );
      return [
        [
          {
            document_id: current.id,
            version: current.version,
            accepted_at: accepted?.accepted_at ?? null,
          },
        ],
        [],
      ];
    }
    // CommunityRuleAcceptanceService.getLatestAcceptance
    if (sql.includes('FROM community_rule_acceptances a')) {
      const [userId, communityId] = values as [string, string];
      const latest = store.acceptances
        .filter(
          (row) => row.user_id === userId && row.community_id === communityId,
        )
        .map((row) => ({
          version:
            store.documents.find((document) => document.id === row.document_id)
              ?.version ?? 0,
          accepted_at: row.accepted_at,
        }))
        .sort((left, right) => right.version - left.version)[0];
      return [latest ? [latest] : [], []];
    }
    // CommunityRuleAcceptanceService.accept: only the current version matches.
    if (sql.startsWith('INSERT INTO community_rule_acceptances')) {
      const [userId, communityId, version] = values as [string, string, number];
      const current = currentDocument(communityId);
      if (!current || current.version !== version) {
        return [{ affectedRows: 0 }, []];
      }
      if (
        !store.acceptances.some(
          (row) => row.user_id === userId && row.document_id === current.id,
        )
      ) {
        store.accept(userId, communityId);
      }
      return [{ affectedRows: 1 }, []];
    }
    // assertAcceptedOrThrow: the name for the 403 and the creator exemption.
    if (
      sql === 'SELECT name, creator_id FROM communities WHERE id = ? LIMIT 1'
    ) {
      const community = store.communities.get(values[0] as string);
      return [community ? [community] : [], []];
    }
    // CommunityRulesService.getCommunity, used by the acceptance routes.
    if (
      sql.startsWith('SELECT id, creator_id FROM communities WHERE name = ?')
    ) {
      const entry = [...store.communities.entries()].find(
        ([, community]) => community.name === values[0],
      );
      return [
        entry ? [{ id: entry[0], creator_id: entry[1].creator_id }] : [],
        [],
      ];
    }
    return undefined;
  }

  return store;
}
