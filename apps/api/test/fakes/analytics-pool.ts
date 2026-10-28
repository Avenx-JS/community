import { ACTIVE_USER_RESTRICTION_PREDICATE } from '../../src/common/active-user-restriction';

export interface FakeUser {
  role: 'user' | 'moderator' | 'admin';
  created_at: Date;
  last_seen_at: Date | null;
}

export interface FakeRestriction {
  user_id: string;
  type: 'suspension' | 'ban';
  created_at: Date;
  expires_at: Date | null;
  lifted_at: Date | null;
}

export interface FakeAnalyticsData {
  users: FakeUser[];
  restrictions: FakeRestriction[];
  /** The database clock used for UTC_TIMESTAMP() in the restriction predicate. */
  now: Date;
}

type Result = [unknown, unknown];

const fromSql = (value: unknown) =>
  new Date(`${String(value).replace(' ', 'T')}Z`);
const inRange = (value: Date | null, values: unknown[]) =>
  value !== null &&
  value.getTime() >= fromSql(values[0]).getTime() &&
  value.getTime() < fromSql(values[1]).getTime();

/**
 * Evaluates the analytics aggregate statements over in-memory rows, so tests
 * observe real half-open, DISTINCT and predicate semantics. Returns undefined
 * for statements it does not handle.
 */
export function executeAnalyticsQuery(
  data: FakeAnalyticsData,
  sql: string,
  values: unknown[],
): Promise<Result> | undefined {
  const result = (rows: unknown) => Promise.resolve([rows, []] as Result);

  if (sql.startsWith('SELECT role AS `key`')) {
    const counts = new Map<string, number>();
    for (const user of data.users) {
      counts.set(user.role, (counts.get(user.role) ?? 0) + 1);
    }
    return result(
      [...counts].map(([key, total]) => ({ key, total: String(total) })),
    );
  }
  if (sql.includes('AS day_number')) {
    const counts = new Map<number, number>();
    for (const user of data.users) {
      if (inRange(user.created_at, values)) {
        const day = Math.floor(user.created_at.getTime() / 86_400_000);
        counts.set(day, (counts.get(day) ?? 0) + 1);
      }
    }
    return result(
      [...counts].map(([day_number, total]) => ({
        day_number: String(day_number),
        total,
      })),
    );
  }
  if (sql.includes('AS active_users')) {
    const seen = data.users
      .map((user) => user.last_seen_at)
      .filter((value): value is Date => value !== null);
    return result([
      {
        active_users: data.users.filter((user) =>
          inRange(user.last_seen_at, values),
        ).length,
        active_users_since:
          seen.length === 0
            ? null
            : new Date(Math.min(...seen.map((value) => value.getTime()))),
      },
    ]);
  }
  if (
    sql.includes('AS suspended_users') &&
    sql.includes(ACTIVE_USER_RESTRICTION_PREDICATE)
  ) {
    const active = data.restrictions.filter(
      (row) =>
        row.lifted_at === null &&
        (row.expires_at === null ||
          row.expires_at.getTime() > data.now.getTime()),
    );
    const distinct = (type: string) =>
      new Set(
        active.filter((row) => row.type === type).map((row) => row.user_id),
      ).size;
    return result([
      {
        suspended_users: distinct('suspension'),
        banned_users: distinct('ban'),
      },
    ]);
  }
  if (sql.includes('FROM user_restrictions') && sql.includes('GROUP BY type')) {
    const counts = new Map<string, number>();
    for (const row of data.restrictions) {
      if (inRange(row.created_at, values)) {
        counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
      }
    }
    return result([...counts].map(([key, total]) => ({ key, total })));
  }
  return undefined;
}
