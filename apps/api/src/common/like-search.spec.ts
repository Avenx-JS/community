import { describe, expect, it } from '@jest/globals';
import { escapeLikeSearch } from './like-search';

describe('escapeLikeSearch', () => {
  it('escapes SQL LIKE wildcards and its escape character', () => {
    expect(escapeLikeSearch('100%_safe=')).toBe('100=%=_safe==');
  });
});
