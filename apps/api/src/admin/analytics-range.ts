import { BadRequestException } from '@nestjs/common';

export const DEFAULT_ANALYTICS_RANGE_DAYS = 30;
export const MAX_ANALYTICS_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

export type AnalyticsGranularity = 'day' | 'week';

export interface AnalyticsRange {
  from: Date;
  to: Date;
}

export interface SeriesPoint {
  bucket: string;
  count: number;
}

// Timestamps without an explicit zone are UTC, matching the admin list routes.
function parseUtc(value: string): Date {
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
  const hasTime = value.includes('T');
  return new Date(hasTime && !hasZone ? `${value}Z` : value);
}

/**
 * Resolves the half-open interval [from, to). Missing bounds default to the
 * 30 days ending at `now` (or ending at `to`). Ranges must be non-empty and at
 * most 366 days, which bounds the work a single request can cause.
 */
export function resolveAnalyticsRange(
  query: { from?: string; to?: string },
  now: Date,
): AnalyticsRange {
  const to = query.to
    ? parseUtc(query.to)
    : new Date(Math.floor(now.getTime() / 1000) * 1000);
  const from = query.from
    ? parseUtc(query.from)
    : new Date(to.getTime() - DEFAULT_ANALYTICS_RANGE_DAYS * DAY_MS);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestException('from and to must be valid dates');
  }
  if (from.getTime() >= to.getTime()) {
    throw new BadRequestException('from must be earlier than to');
  }
  if (to.getTime() - from.getTime() > MAX_ANALYTICS_RANGE_DAYS * DAY_MS) {
    throw new BadRequestException(
      `The range must not exceed ${MAX_ANALYTICS_RANGE_DAYS} days`,
    );
  }
  return { from, to };
}

/** UTC SQL literal for use with CONVERT_TZ(?, '+00:00', @@session.time_zone). */
export function toUtcSqlLiteral(value: Date): string {
  return value.toISOString().slice(0, 23).replace('T', ' ');
}

/** Days since the Unix epoch in UTC, the unit SQL groups by. */
export function utcDayNumber(value: Date): number {
  return Math.floor(value.getTime() / DAY_MS);
}

function dayLabel(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

/** ISO 8601 week label, e.g. 2026-W53; the week-year can differ from the date's year. */
export function isoWeekLabel(dayNumber: number): string {
  const date = new Date(dayNumber * DAY_MS);
  const weekday = (date.getUTCDay() + 6) % 7;
  const thursday = new Date((dayNumber - weekday + 3) * DAY_MS);
  const weekYear = thursday.getUTCFullYear();
  const firstThursday = Date.UTC(weekYear, 0, 4);
  const firstWeekday = (new Date(firstThursday).getUTCDay() + 6) % 7;
  const firstMonday = firstThursday - firstWeekday * DAY_MS;
  const week =
    Math.floor((thursday.getTime() - firstMonday) / (7 * DAY_MS)) + 1;
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Builds a gap-free series covering every bucket that intersects
 * [from, to). MySQL emits no row for an empty day, so missing buckets are
 * filled with 0 here; a chart would otherwise interpolate across the gap.
 */
export function buildZeroFilledSeries(
  range: AnalyticsRange,
  granularity: AnalyticsGranularity,
  dailyCounts: ReadonlyMap<number, number>,
): SeriesPoint[] {
  const firstDay = utcDayNumber(range.from);
  const lastDay = utcDayNumber(new Date(range.to.getTime() - 1));
  const series: SeriesPoint[] = [];

  for (let day = firstDay; day <= lastDay; day += 1) {
    const bucket = granularity === 'week' ? isoWeekLabel(day) : dayLabel(day);
    const count = dailyCounts.get(day) ?? 0;
    const last = series[series.length - 1];
    if (last?.bucket === bucket) {
      last.count += count;
    } else {
      series.push({ bucket, count });
    }
  }
  return series;
}
