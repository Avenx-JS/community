import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import {
  buildZeroFilledSeries,
  isoWeekLabel,
  resolveAnalyticsRange,
  toUtcSqlLiteral,
  utcDayNumber,
} from './analytics-range';

const utc = (value: string) => new Date(value);
const day = (value: string) => utcDayNumber(utc(value));
const range = (from: string, to: string) => ({ from: utc(from), to: utc(to) });

describe('resolveAnalyticsRange', () => {
  const now = utc('2026-10-23T09:14:02.789Z');

  it('defaults to the 30 days ending now, truncated to the second', () => {
    expect(resolveAnalyticsRange({}, now)).toEqual(
      range('2026-09-23T09:14:02.000Z', '2026-10-23T09:14:02.000Z'),
    );
  });

  it('defaults a missing bound relative to the given one', () => {
    expect(resolveAnalyticsRange({ to: '2026-02-01T00:00:00Z' }, now)).toEqual(
      range('2026-01-02T00:00:00Z', '2026-02-01T00:00:00Z'),
    );
    expect(
      resolveAnalyticsRange({ from: '2026-10-01T00:00:00Z' }, now).to,
    ).toEqual(utc('2026-10-23T09:14:02.000Z'));
  });

  it('interprets zone-less timestamps and dates as UTC and honours offsets', () => {
    expect(
      resolveAnalyticsRange(
        { from: '2026-01-01T00:00:00', to: '2026-01-02' },
        now,
      ),
    ).toEqual(range('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'));
    expect(
      resolveAnalyticsRange(
        { from: '2026-01-01T01:00:00+01:00', to: '2026-01-02T00:00:00Z' },
        now,
      ).from,
    ).toEqual(utc('2026-01-01T00:00:00Z'));
  });

  it.each([
    [{ from: '2026-01-02T00:00:00Z', to: '2026-01-02T00:00:00Z' }],
    [{ from: '2026-01-03T00:00:00Z', to: '2026-01-02T00:00:00Z' }],
    [{ from: '2027-01-01T00:00:00Z' }],
    [{ from: '2025-01-01T00:00:00Z', to: '2026-01-02T00:00:01Z' }],
    [{ from: '2020-01-01T00:00:00Z' }],
  ])('rejects %o with 400', (query) => {
    expect(() => resolveAnalyticsRange(query, now)).toThrow(
      BadRequestException,
    );
  });

  it('accepts exactly 366 days', () => {
    expect(() =>
      resolveAnalyticsRange(
        { from: '2024-01-01T00:00:00Z', to: '2025-01-01T00:00:00Z' },
        now,
      ),
    ).not.toThrow();
  });
});

describe('toUtcSqlLiteral', () => {
  it('formats a UTC literal with milliseconds', () => {
    expect(toUtcSqlLiteral(utc('2026-10-23T09:14:02.120Z'))).toBe(
      '2026-10-23 09:14:02.120',
    );
  });
});

describe('isoWeekLabel', () => {
  it.each([
    ['2026-09-23', '2026-W39'],
    ['2026-12-28', '2026-W53'],
    ['2027-01-03', '2026-W53'],
    ['2027-01-04', '2027-W01'],
    ['2024-12-30', '2025-W01'],
    ['2021-01-03', '2020-W53'],
  ])('labels %s as %s', (date, label) => {
    expect(isoWeekLabel(day(`${date}T12:00:00Z`))).toBe(label);
  });
});

describe('buildZeroFilledSeries', () => {
  it('emits one bucket per day including zero days', () => {
    const counts = new Map([
      [day('2026-09-23T00:00:00Z'), 4],
      [day('2026-09-25T00:00:00Z'), 2],
    ]);

    expect(
      buildZeroFilledSeries(
        range('2026-09-23T00:00:00Z', '2026-09-26T00:00:00Z'),
        'day',
        counts,
      ),
    ).toEqual([
      { bucket: '2026-09-23', count: 4 },
      { bucket: '2026-09-24', count: 0 },
      { bucket: '2026-09-25', count: 2 },
    ]);
  });

  it('fills an entirely empty range with zeros', () => {
    const series = buildZeroFilledSeries(
      range('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z'),
      'day',
      new Map(),
    );
    expect(series).toHaveLength(30);
    expect(series.every((point) => point.count === 0)).toBe(true);
  });

  it('treats the end as exclusive and partial days as buckets', () => {
    expect(
      buildZeroFilledSeries(
        range('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
        'day',
        new Map(),
      ).map((point) => point.bucket),
    ).toEqual(['2026-01-01']);
    expect(
      buildZeroFilledSeries(
        range('2026-01-01T12:00:00Z', '2026-01-03T00:00:01Z'),
        'day',
        new Map(),
      ).map((point) => point.bucket),
    ).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
  });

  it('buckets by ISO week across a year boundary and preserves the sum', () => {
    const counts = new Map([
      [day('2026-12-27T00:00:00Z'), 1],
      [day('2026-12-31T00:00:00Z'), 2],
      [day('2027-01-03T00:00:00Z'), 3],
      [day('2027-01-04T00:00:00Z'), 4],
    ]);

    const series = buildZeroFilledSeries(
      range('2026-12-20T00:00:00Z', '2027-01-12T00:00:00Z'),
      'week',
      counts,
    );

    expect(series).toEqual([
      { bucket: '2026-W51', count: 0 },
      { bucket: '2026-W52', count: 1 },
      { bucket: '2026-W53', count: 5 },
      { bucket: '2027-W01', count: 4 },
      { bucket: '2027-W02', count: 0 },
    ]);
    expect(series.reduce((sum, point) => sum + point.count, 0)).toBe(10);
  });
});
