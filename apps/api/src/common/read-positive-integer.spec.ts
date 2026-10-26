import { afterEach, describe, expect, it } from '@jest/globals';
import { readPositiveInteger } from './read-positive-integer';

describe('readPositiveInteger', () => {
  const previousValue = process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS;

  afterEach(() => {
    if (previousValue === undefined) {
      delete process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS;
    } else {
      process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS = previousValue;
    }
  });

  it('uses the fallback when unset and accepts a valid override', () => {
    delete process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS;
    expect(
      readPositiveInteger('USER_ACTIVITY_WRITE_INTERVAL_SECONDS', 300),
    ).toBe(300);

    process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS = '900';
    expect(
      readPositiveInteger('USER_ACTIVITY_WRITE_INTERVAL_SECONDS', 300),
    ).toBe(900);
  });

  it.each(['0', '-1', '86401', '1.5', 'invalid'])(
    'rejects malformed and out-of-range values: %s',
    (value) => {
      process.env.USER_ACTIVITY_WRITE_INTERVAL_SECONDS = value;
      expect(() =>
        readPositiveInteger('USER_ACTIVITY_WRITE_INTERVAL_SECONDS', 300),
      ).toThrow(
        'USER_ACTIVITY_WRITE_INTERVAL_SECONDS must be an integer between 1 and 86400',
      );
    },
  );
});
