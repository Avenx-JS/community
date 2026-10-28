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

export interface FakeReport {
  reason: string;
  status: 'open' | 'under_review' | 'resolved' | 'rejected';
  resolution: string | null;
  created_at: Date;
  reviewed_at: Date | null;
}

export interface FakeAnalyticsData {
  users: FakeUser[];
  restrictions: FakeRestriction[];
  reports?: FakeReport[];
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
  const reports = data.reports ?? [];
  // Honour the statement's own status list, so a missing filter is visible.
  const statusFilter = (rows: FakeReport[]) => {
    const match = /status IN \(([^)]*)\)/.exec(sql);
    if (!match) return rows;
    const allowed = match[1]
      .split(',')
      .map((value) => value.trim().slice(1, -1));
    return rows.filter((row) => allowed.includes(row.status));
  };
  const seconds = (value: Date) => Math.floor(value.getTime() / 1000);

  if (sql.includes('FROM user_reports') && sql.includes('AS day_number')) {
    const groups = new Map<
      string,
      { day_number: number; key: string; total: number }
    >();
    for (const report of reports) {
      if (inRange(report.created_at, values)) {
        const day = Math.floor(report.created_at.getTime() / 86_400_000);
        const id = `${day}:${report.reason}`;
        const group = groups.get(id) ?? {
          day_number: day,
          key: report.reason,
          total: 0,
        };
        group.total += 1;
        groups.set(id, group);
      }
    }
    return result([...groups.values()]);
  }
  if (sql.includes('FROM user_reports') && sql.includes('review_seconds_sum')) {
    const groups = new Map<
      string,
      {
        status: string;
        resolution: string | null;
        total: number;
        review_seconds_sum: number;
        review_seconds_max: number;
      }
    >();
    for (const report of statusFilter(reports)) {
      if (report.reviewed_at === null || !inRange(report.reviewed_at, values)) {
        continue;
      }
      const duration = seconds(report.reviewed_at) - seconds(report.created_at);
      const id = `${report.status}:${report.resolution}`;
      const group = groups.get(id) ?? {
        status: report.status,
        resolution: report.resolution,
        total: 0,
        review_seconds_sum: 0,
        review_seconds_max: Number.NEGATIVE_INFINITY,
      };
      group.total += 1;
      group.review_seconds_sum += duration;
      group.review_seconds_max = Math.max(group.review_seconds_max, duration);
      groups.set(id, group);
    }
    return result(
      [...groups.values()].map((group) => ({
        ...group,
        review_seconds_sum: String(group.review_seconds_sum),
      })),
    );
  }
  if (sql.startsWith('SELECT status AS `key`')) {
    const counts = new Map<string, number>();
    for (const report of reports) {
      counts.set(report.status, (counts.get(report.status) ?? 0) + 1);
    }
    return result([...counts].map(([key, total]) => ({ key, total })));
  }
  if (sql.includes('AS oldest_open_report_age_seconds')) {
    const open = statusFilter(reports);
    return result([
      {
        oldest_open_report_age_seconds:
          open.length === 0
            ? null
            : seconds(data.now) -
              Math.min(...open.map((report) => seconds(report.created_at))),
      },
    ]);
  }
  if (sql.includes('FROM user_restrictions') && sql.includes('lifted_at >=')) {
    return result([
      {
        total: data.restrictions.filter((row) => inRange(row.lifted_at, values))
          .length,
      },
    ]);
  }

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
