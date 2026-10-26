import { describe, expect, it } from '@jest/globals';
import { ACTIVE_USER_RESTRICTION_PREDICATE } from './active-user-restriction';

describe('active user restriction predicate', () => {
  it('uses the shared lifted and expiry conditions with the UTC clock', () => {
    expect(ACTIVE_USER_RESTRICTION_PREDICATE).toBe(
      'lifted_at IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())',
    );
  });
});
