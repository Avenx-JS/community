import { ADMIN_COMMUNITY_DETAIL_SQL } from '../../src/admin/admin-communities.service';

export interface FakeDirectoryUser {
  id: string;
  username: string;
  email: string;
  deleted: boolean;
}

export interface FakeDirectoryCommunity {
  id: string;
  creator_id: string;
  name: string;
  description: string | null;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  suspended_at: string | null;
  suspended_by: string | null;
  suspension_reason: string | null;
}

export interface CommunityDirectoryStore {
  users: FakeDirectoryUser[];
  communities: FakeDirectoryCommunity[];
  subscriptions: Array<{ community_id: string; user_id: string }>;
  moderators: Array<{ community_id: string; user_id: string }>;
  posts: Array<{ id: string; community_id: string }>;
  comments: Array<{ id: string; post_id: string }>;
  ruleVersions: Array<{ community_id: string; version: number }>;
  reports: Array<{
    target_type: string;
    target_id: string;
    status: string;
    withdrawn: boolean;
  }>;
  audit: unknown[][];
}

type Result = [unknown, unknown];

// The admin community directory's SQL and the public community listing,
// answered from the same tables, so a test can compare the two views. Each
// statement is evaluated by the predicates its SQL states.
export function executeCommunityDirectoryQuery(
  store: CommunityDirectoryStore,
  sql: string,
  values: unknown[],
): Result | null {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const user = (id: string | null) =>
    id === null ? undefined : store.users.find((row) => row.id === id);
  const visible = (id: string | null) => {
    const found = user(id);
    return found && !found.deleted ? found.username : null;
  };
  const count = <T extends { community_id: string }>(rows: T[], id: string) =>
    rows.filter((row) => row.community_id === id).length;
  const listItem = (row: FakeDirectoryCommunity) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    creator_username: visible(row.creator_id),
    created_at: row.created_at,
    suspended_at: row.suspended_at,
    deleted_at: row.deleted_at,
  });
  // LIKE with ESCAPE '=': % and _ are wildcards unless escaped by =.
  const like = (pattern: string) =>
    new RegExp(
      `^${pattern.replace(
        /=(.)|([%_])|([.*+?^${}()|[\]\\])/g,
        (_m, escaped: string, wild: string, special: string) =>
          escaped !== undefined
            ? escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            : wild === '%'
              ? '.*'
              : wild === '_'
                ? '.'
                : `\\${special}`,
      )}$`,
      'is',
    );
  const ordered = (rows: FakeDirectoryCommunity[]) => {
    const direction = flat.includes('created_at ASC') ? 1 : -1;
    return [...rows].sort(
      (a, b) =>
        direction *
        (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    );
  };
  const paged = (rows: unknown[]) => {
    const limit = Number(values[values.length - 2]);
    const offset = Number(values[values.length - 1]);
    return rows.slice(offset, offset + limit);
  };

  if (sql === ADMIN_COMMUNITY_DETAIL_SQL) {
    const row = store.communities.find((c) => c.id === values[0]);
    if (!row) return [[], []];
    const posts = store.posts.filter((p) => p.community_id === row.id);
    const versions = store.ruleVersions
      .filter((d) => d.community_id === row.id)
      .map((d) => d.version);
    return [
      [
        {
          ...listItem(row),
          suspended_by_username: visible(row.suspended_by),
          suspension_reason: row.suspension_reason,
          deleted_by_username: visible(row.deleted_by),
          member_count: count(store.subscriptions, row.id),
          post_count: posts.length,
          moderator_count: count(store.moderators, row.id),
          comment_count: store.comments.filter((c) =>
            posts.some((p) => p.id === c.post_id),
          ).length,
          rule_version: versions.length ? Math.max(...versions) : null,
          open_report_count: store.reports.filter(
            (r) =>
              r.target_type === 'community' &&
              r.target_id === row.id &&
              ['open', 'under_review'].includes(r.status) &&
              !r.withdrawn,
          ).length,
        },
      ],
      [],
    ];
  }

  // The admin listing and its count: FROM communities c LEFT JOIN users creator.
  if (
    flat.includes(
      'FROM communities c LEFT JOIN users creator ON creator.id = c.creator_id',
    )
  ) {
    let at = 0;
    let rows = store.communities;
    if (flat.includes('LOWER(c.name) LIKE LOWER(?)')) {
      const pattern = like(String(values[at]));
      at += 2;
      rows = rows.filter(
        (row) => pattern.test(row.name) || pattern.test(row.description ?? ''),
      );
    }
    if (flat.includes('creator.username = ?')) {
      const name = values[at++];
      rows = rows.filter((row) => user(row.creator_id)?.username === name);
    }
    if (flat.includes('c.deleted_at IS NULL AND c.suspended_at IS NULL')) {
      rows = rows.filter((row) => !row.deleted_at && !row.suspended_at);
    } else if (
      flat.includes('c.suspended_at IS NOT NULL AND c.deleted_at IS NULL')
    ) {
      rows = rows.filter((row) => row.suspended_at && !row.deleted_at);
    } else if (flat.includes('c.deleted_at IS NOT NULL')) {
      rows = rows.filter((row) => row.deleted_at);
    }
    if (flat.startsWith('SELECT COUNT(*) AS total')) {
      return [[{ total: rows.length }], []];
    }
    return [paged(ordered(rows).map(listItem)), []];
  }

  const grouped =
    /^SELECT community_id, COUNT\(\*\) AS total FROM (community_subscriptions|posts) WHERE community_id IN/.exec(
      flat,
    );
  if (grouped) {
    const table: Array<{ community_id: string }> =
      grouped[1] === 'posts' ? store.posts : store.subscriptions;
    return [
      (values as string[])
        .map((id) => ({ community_id: id, total: count(table, id) }))
        .filter((row) => row.total > 0),
      [],
    ];
  }

  // GET /communities/:name: one visible community by name.
  if (
    flat ===
    'SELECT id, creator_id, name, description, created_at FROM communities WHERE name = ? AND deleted_at IS NULL AND suspended_at IS NULL LIMIT 1'
  ) {
    return [
      store.communities
        .filter(
          (row) =>
            row.name === values[0] && !row.deleted_at && !row.suspended_at,
        )
        .map(({ id, creator_id, name, description, created_at }) => ({
          id,
          creator_id,
          name,
          description,
          created_at,
        })),
      [],
    ];
  }

  // The public GET /communities listing and its count: visible ones only.
  if (
    /FROM communities WHERE deleted_at IS NULL AND suspended_at IS NULL/.test(
      flat,
    )
  ) {
    let rows = store.communities.filter(
      (row) => !row.deleted_at && !row.suspended_at,
    );
    if (flat.includes('LIKE LOWER(?)')) {
      const pattern = like(String(values[0]));
      rows = rows.filter(
        (row) => pattern.test(row.name) || pattern.test(row.description ?? ''),
      );
    }
    if (flat.startsWith('SELECT COUNT(*) AS total')) {
      return [[{ total: rows.length }], []];
    }
    return [
      paged(
        ordered(rows).map((row) => ({
          id: row.id,
          creator_id: row.creator_id,
          name: row.name,
          description: row.description,
          created_at: row.created_at,
        })),
      ),
      [],
    ];
  }

  // POST /admin/communities/:id/suspend and /restore.
  if (
    flat ===
    'SELECT id, name, suspended_at, deleted_at FROM communities WHERE id = ? LIMIT 1 FOR UPDATE'
  ) {
    const row = store.communities.find((c) => c.id === values[0]);
    return [
      row
        ? [
            {
              id: row.id,
              name: row.name,
              suspended_at: row.suspended_at,
              deleted_at: row.deleted_at,
            },
          ]
        : [],
      [],
    ];
  }
  if (
    flat.startsWith('UPDATE communities SET suspended_at = UTC_TIMESTAMP()')
  ) {
    const [actor, reason, id] = values as string[];
    const row = store.communities.find(
      (c) => c.id === id && !c.suspended_at && !c.deleted_at,
    );
    if (row) {
      Object.assign(row, {
        suspended_at: '2026-11-09T12:00:00.000Z',
        suspended_by: actor,
        suspension_reason: reason,
      });
    }
    return [{ affectedRows: row ? 1 : 0 }, []];
  }
  if (flat.startsWith('UPDATE communities SET suspended_at = NULL')) {
    const row = store.communities.find(
      (c) => c.id === values[0] && c.suspended_at,
    );
    if (row) {
      Object.assign(row, {
        suspended_at: null,
        suspended_by: null,
        suspension_reason: null,
      });
    }
    return [{ affectedRows: row ? 1 : 0 }, []];
  }
  if (flat === 'SELECT name FROM communities WHERE id = ? LIMIT 1') {
    const row = store.communities.find((c) => c.id === values[0]);
    return [row ? [{ name: row.name }] : [], []];
  }
  if (
    flat === 'SELECT id, name FROM communities WHERE id = ? LIMIT 1 FOR UPDATE'
  ) {
    const row = store.communities.find((c) => c.id === values[0]);
    return [row ? [{ id: row.id, name: row.name }] : [], []];
  }
  if (flat.startsWith('UPDATE communities SET description = ? WHERE id = ?')) {
    const row = store.communities.find((c) => c.id === values[1]);
    if (row) row.description = values[0] as string | null;
    return [{ affectedRows: row ? 1 : 0 }, []];
  }
  if (flat === 'SELECT username FROM users WHERE id = ? LIMIT 1') {
    const found = user(values[0] as string);
    return [found ? [{ username: found.username }] : [], []];
  }
  if (flat.startsWith('INSERT INTO admin_actions')) {
    store.audit.push(values);
    return [{ affectedRows: 1 }, []];
  }
  return null;
}
