import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MYSQL_POOL } from '../auth/auth.service';
import { ACTIVE_USER_RESTRICTION_PREDICATE } from '../common/active-user-restriction';
import { readPositiveInteger } from '../common/read-positive-integer';
import {
  REPORT_REASONS,
  REPORT_RESOLUTIONS,
  REPORT_STATUSES,
} from '../reports/report.constants';
import type {
  ReportReason,
  ReportResolution,
  ReportStatus,
} from '../reports/report.constants';
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
const REVIEWED_STATUSES: readonly ReportStatus[] = ['resolved', 'rejected'];
const BACKLOG_QUEUE_STATUSES: readonly ReportStatus[] = [
  'open',
  'under_review',
];

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

interface SubmittedReportRow extends RowDataPacket {
  day_number: number | string;
  key: ReportReason;
  total: number | string;
}

interface ReviewedReportRow extends RowDataPacket {
  status: ReportStatus;
  resolution: ReportResolution | null;
  total: number | string;
  review_seconds_sum: number | string | null;
  review_seconds_max: number | string | null;
}

interface OldestOpenRow extends RowDataPacket {
  oldest_open_report_age_seconds: number | string | null;
}

export interface ModerationAnalytics {
  from: string;
  to: string;
  granularity: AnalyticsGranularity;
  generated_at: string;
  totals: {
    reports_submitted: number;
    reports_reviewed: number;
    restrictions_lifted: number;
  };
  point_in_time: {
    backlog_by_status: Record<ReportStatus, number>;
    oldest_open_report_age_seconds: number | null;
  };
  reports_by_reason: Record<ReportReason, number>;
  resolutions_by_type: Record<ReportResolution | 'rejected', number>;
  time_to_review_seconds: {
    average: number | null;
    maximum: number | null;
    count: number;
  };
  restrictions_applied: Record<RestrictionType, number>;
  series: { reports_submitted: SeriesPoint[] };
  meta: { time_basis: Record<string, string> };
}

// Names the column each metric filters on, so submitted and decided
// populations cannot be read as comparable figures.
export const MODERATION_METRIC_TIME_BASIS: Record<string, string> = {
  reports_submitted: 'user_reports.created_at',
  'series.reports_submitted': 'user_reports.created_at',
  reports_by_reason: 'user_reports.created_at',
  reports_reviewed: 'user_reports.reviewed_at',
  resolutions_by_type: 'user_reports.reviewed_at',
  time_to_review_seconds: 'user_reports.reviewed_at',
  restrictions_applied: 'user_restrictions.created_at',
  restrictions_lifted: 'user_restrictions.lifted_at',
  'point_in_time.backlog_by_status': 'point_in_time',
  'point_in_time.oldest_open_report_age_seconds': 'point_in_time',
};

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
      this.restrictionsAppliedQuery(bounds),
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

  // A fixed set of six statements regardless of the range length. Submitted
  // and decided reports are different populations from different columns;
  // keep them in separate statements and never merge them into one query.
  async moderationMetrics(
    range: AnalyticsRange,
    granularity: AnalyticsGranularity,
    now: Date = new Date(),
  ): Promise<ModerationAnalytics> {
    const bounds = [toUtcSqlLiteral(range.from), toUtcSqlLiteral(range.to)];
    const decided = REVIEWED_STATUSES.map((status) => `'${status}'`).join(', ');
    const queued = BACKLOG_QUEUE_STATUSES.map((status) => `'${status}'`).join(
      ', ',
    );

    const [
      [submittedRows],
      [reviewedRows],
      [backlogRows],
      [oldestRows],
      [appliedRows],
      [liftedRows],
    ] = await Promise.all([
      // Submitted population: user_reports.created_at.
      this.pool.execute<SubmittedReportRow[]>(
        `SELECT FLOOR(UNIX_TIMESTAMP(created_at) / 86400) AS day_number,
           reason AS \`key\`, COUNT(*) AS total
         FROM user_reports
         WHERE ${IN_RANGE('created_at')}
         GROUP BY day_number, reason`,
        bounds,
      ),
      // Decided population: user_reports.reviewed_at of terminal reports.
      // reviewed_at is also written when a report enters under_review, so
      // only resolved and rejected rows carry a decision time. UNIX_TIMESTAMP
      // differences stay exact across session time zones and DST changes.
      this.pool.execute<ReviewedReportRow[]>(
        `SELECT status, resolution, COUNT(*) AS total,
           SUM(UNIX_TIMESTAMP(reviewed_at) - UNIX_TIMESTAMP(created_at)) AS review_seconds_sum,
           MAX(UNIX_TIMESTAMP(reviewed_at) - UNIX_TIMESTAMP(created_at)) AS review_seconds_max
         FROM user_reports
         WHERE ${IN_RANGE('reviewed_at')} AND status IN (${decided})
         GROUP BY status, resolution`,
        bounds,
      ),
      // Point in time: ignores the range.
      this.pool.execute<GroupCountRow[]>(
        'SELECT status AS `key`, COUNT(*) AS total FROM user_reports GROUP BY status',
        [],
      ),
      this.pool.execute<OldestOpenRow[]>(
        `SELECT UNIX_TIMESTAMP() - UNIX_TIMESTAMP(MIN(created_at)) AS oldest_open_report_age_seconds
         FROM user_reports
         WHERE status IN (${queued})`,
        [],
      ),
      this.restrictionsAppliedQuery(bounds),
      // Lifted population: user_restrictions.lifted_at. Expiry never sets
      // lifted_at, so restrictions that merely ran out are not counted.
      this.pool.execute<(RowDataPacket & { total: number | string })[]>(
        `SELECT COUNT(*) AS total
         FROM user_restrictions
         WHERE ${IN_RANGE('lifted_at')}`,
        bounds,
      ),
    ]);

    const dailyCounts = new Map<number, number>();
    const byReason = new Map<string, number>();
    for (const row of submittedRows) {
      const day = Number(row.day_number);
      dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + Number(row.total));
      byReason.set(row.key, (byReason.get(row.key) ?? 0) + Number(row.total));
    }
    const series = buildZeroFilledSeries(range, granularity, dailyCounts);

    const resolutions = Object.fromEntries(
      [...REPORT_RESOLUTIONS, 'rejected'].map((key) => [key, 0]),
    ) as ModerationAnalytics['resolutions_by_type'];
    let reviewedCount = 0;
    let reviewSecondsSum = 0;
    let reviewSecondsMax: number | null = null;
    for (const row of reviewedRows) {
      const total = Number(row.total);
      reviewedCount += total;
      reviewSecondsSum += Number(row.review_seconds_sum ?? 0);
      const max = Number(row.review_seconds_max ?? 0);
      reviewSecondsMax =
        reviewSecondsMax === null ? max : Math.max(reviewSecondsMax, max);
      // Draft 07 forbids a resolution on rejected reports, so they get their
      // own bucket rather than one of the resolution values.
      const key = row.status === 'rejected' ? 'rejected' : row.resolution;
      if (key !== null && key in resolutions) {
        resolutions[key] += total;
      }
    }

    const oldest = oldestRows[0]?.oldest_open_report_age_seconds;

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      granularity,
      generated_at: now.toISOString(),
      totals: {
        reports_submitted: series.reduce((sum, point) => sum + point.count, 0),
        reports_reviewed: reviewedCount,
        restrictions_lifted: Number(liftedRows[0]?.total ?? 0),
      },
      point_in_time: {
        backlog_by_status: zeroFilledCounts(REPORT_STATUSES, backlogRows),
        oldest_open_report_age_seconds:
          oldest === null || oldest === undefined
            ? null
            : Math.max(0, Math.floor(Number(oldest))),
      },
      reports_by_reason: zeroFilledCounts(
        REPORT_REASONS,
        [...byReason].map(([key, total]) => ({ key, total }) as GroupCountRow),
      ),
      resolutions_by_type: resolutions,
      time_to_review_seconds: {
        average:
          reviewedCount === 0
            ? null
            : Math.round(reviewSecondsSum / reviewedCount),
        maximum: reviewSecondsMax,
        count: reviewedCount,
      },
      restrictions_applied: zeroFilledCounts(RESTRICTION_TYPES, appliedRows),
      series: { reports_submitted: series },
      meta: { time_basis: MODERATION_METRIC_TIME_BASIS },
    };
  }

  private restrictionsAppliedQuery(bounds: string[]) {
    return this.pool.execute<GroupCountRow[]>(
      `SELECT type AS \`key\`, COUNT(*) AS total
       FROM user_restrictions
       WHERE ${IN_RANGE('created_at')}
       GROUP BY type`,
      bounds,
    );
  }
}
