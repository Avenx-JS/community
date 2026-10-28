import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { ACTIVE_USER_RESTRICTION_PREDICATE } from '../common/active-user-restriction';
import { readPositiveInteger } from '../common/read-positive-integer';
import type { PlatformRole } from '../users/users.service';
import {
  AnalyticsGranularity,
  AnalyticsRange,
  buildZeroFilledSeries,
  SeriesPoint,
  toUtcSqlLiteral,
} from './analytics-range';
import type { RestrictionType } from './dto/create-restriction.dto';

const PLATFORM_ROLES: readonly PlatformRole[] = ['user', 'moderator', 'admin'];
const RESTRICTION_TYPES: readonly RestrictionType[] = ['suspension', 'ban'];

const IN_RANGE = (column: string) =>
  `${column} >= CONVERT_TZ(?, '+00:00', @@session.time_zone)
     AND ${column} < CONVERT_TZ(?, '+00:00', @@session.time_zone)`;

interface GroupCountRow extends RowDataPacket {
  key: string;
  total: number | string;
}

interface DailyCountRow extends RowDataPacket {
  day_number: number | string;
  total: number | string;
}

interface ActivityRow extends RowDataPacket {
  active_users: number | string;
  active_users_since: Date | string | null;
}

interface ActiveRestrictionCountsRow extends RowDataPacket {
  suspended_users: number | string;
  banned_users: number | string;
}

export type MetricScope = 'point_in_time' | 'range';

export interface UserAnalytics {
  from: string;
  to: string;
  granularity: AnalyticsGranularity;
  generated_at: string;
  totals: {
    total_users: number;
    new_users: number;
    active_users: number;
    suspended_users: number;
    banned_users: number;
  };
  users_by_role: Record<PlatformRole, number>;
  restrictions_applied: Record<RestrictionType, number>;
  series: { new_users: SeriesPoint[] };
  meta: {
    active_users_since: string | null;
    active_users_resolution_seconds: number;
    active_users_is_floor: boolean;
    scopes: Record<string, MetricScope>;
  };
}

// Labels every metric so a dashboard cannot read a point-in-time count such
// as suspended_users as "suspended during the range".
export const USER_METRIC_SCOPES: Record<string, MetricScope> = {
  total_users: 'point_in_time',
  new_users: 'range',
  active_users: 'range',
  suspended_users: 'point_in_time',
  banned_users: 'point_in_time',
  users_by_role: 'point_in_time',
  restrictions_applied: 'range',
  'series.new_users': 'range',
};

function zeroFilledCounts<K extends string>(
  keys: readonly K[],
  rows: GroupCountRow[],
): Record<K, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
    K,
    number
  >;
  for (const row of rows) {
    if ((keys as readonly string[]).includes(row.key)) {
      counts[row.key as K] = Number(row.total);
    }
  }
  return counts;
}

/**
 * last_seen_at holds only each account's most recent request, so a count over
 * [from, to) is a floor when collection had not started by `from`, or when
 * `to` lies in the past: accounts active in the window and again afterwards
 * have moved out of it.
 */
export function isActiveUsersFloor(
  range: AnalyticsRange,
  activeUsersSince: Date | null,
  generatedAt: Date,
  resolutionSeconds: number,
): boolean {
  if (activeUsersSince === null) {
    return true;
  }
  return (
    range.from.getTime() < activeUsersSince.getTime() ||
    range.to.getTime() < generatedAt.getTime() - resolutionSeconds * 1000
  );
}

@Injectable()
export class AdminAnalyticsService {
  private readonly activityResolutionSeconds = readPositiveInteger(
    'USER_ACTIVITY_WRITE_INTERVAL_SECONDS',
    300,
  );

  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  // A fixed set of five statements regardless of the range length; the
  // series is grouped by UTC day in SQL and bucketed in application code.
  async userMetrics(
    range: AnalyticsRange,
    granularity: AnalyticsGranularity,
    now: Date = new Date(),
  ): Promise<UserAnalytics> {
    const bounds = [toUtcSqlLiteral(range.from), toUtcSqlLiteral(range.to)];

    const [
      [roleRows],
      [dailyRows],
      [activityRows],
      [restrictionRows],
      [appliedRows],
    ] = await Promise.all([
      this.pool.execute<GroupCountRow[]>(
        'SELECT role AS `key`, COUNT(*) AS total FROM users GROUP BY role',
        [],
      ),
      this.pool.execute<DailyCountRow[]>(
        `SELECT FLOOR(UNIX_TIMESTAMP(created_at) / 86400) AS day_number,
           COUNT(*) AS total
         FROM users
         WHERE ${IN_RANGE('created_at')}
         GROUP BY day_number`,
        bounds,
      ),
      this.pool.execute<ActivityRow[]>(
        `SELECT COUNT(*) AS active_users,
           (SELECT MIN(last_seen_at) FROM users) AS active_users_since
         FROM users
         WHERE ${IN_RANGE('last_seen_at')}`,
        bounds,
      ),
      // COUNT(DISTINCT user_id): the schema allows several active rows per
      // account, and the shared predicate keeps this in line with enforcement.
      this.pool.execute<ActiveRestrictionCountsRow[]>(
        `SELECT
           COUNT(DISTINCT CASE WHEN type = 'suspension' THEN user_id END) AS suspended_users,
           COUNT(DISTINCT CASE WHEN type = 'ban' THEN user_id END) AS banned_users
         FROM user_restrictions
         WHERE ${ACTIVE_USER_RESTRICTION_PREDICATE}`,
        [],
      ),
      this.pool.execute<GroupCountRow[]>(
        `SELECT type AS \`key\`, COUNT(*) AS total
         FROM user_restrictions
         WHERE ${IN_RANGE('created_at')}
         GROUP BY type`,
        bounds,
      ),
    ]);

    const dailyCounts = new Map(
      dailyRows.map((row) => [Number(row.day_number), Number(row.total)]),
    );
    const series = buildZeroFilledSeries(range, granularity, dailyCounts);
    const usersByRole = zeroFilledCounts(PLATFORM_ROLES, roleRows);
    const activity = activityRows[0];
    const activeUsersSince =
      activity?.active_users_since === null ||
      activity?.active_users_since === undefined
        ? null
        : new Date(activity.active_users_since);
    const restrictions = restrictionRows[0];

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      granularity,
      generated_at: now.toISOString(),
      totals: {
        total_users: Object.values<number>(usersByRole).reduce(
          (sum, count) => sum + count,
          0,
        ),
        new_users: series.reduce((sum, point) => sum + point.count, 0),
        active_users: Number(activity?.active_users ?? 0),
        suspended_users: Number(restrictions?.suspended_users ?? 0),
        banned_users: Number(restrictions?.banned_users ?? 0),
      },
      users_by_role: usersByRole,
      restrictions_applied: zeroFilledCounts(RESTRICTION_TYPES, appliedRows),
      series: { new_users: series },
      meta: {
        active_users_since: activeUsersSince?.toISOString() ?? null,
        active_users_resolution_seconds: this.activityResolutionSeconds,
        active_users_is_floor: isActiveUsersFloor(
          range,
          activeUsersSince,
          now,
          this.activityResolutionSeconds,
        ),
        scopes: USER_METRIC_SCOPES,
      },
    };
  }
}
