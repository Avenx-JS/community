import { describe, expect, it } from '@jest/globals';
import { addedMentions, extractMentions, mentionText } from './mentions';

describe('extractMentions', () => {
  it.each([
    [
      'a mention, case-insensitively distinct',
      '@maintainer can you confirm? cc @Bob_1, @MAINTAINER',
      ['maintainer', 'Bob_1'],
    ],
    [
      'punctuation after the name',
      '(@alice), @bob. @carol!',
      ['alice', 'bob', 'carol'],
    ],
    ['an email address', 'write to dev@example.com', []],
    ['a double @', '@@carol', []],
    ['a word before the @', 'foo@bar_baz', []],
    ['a name too short', '@ab', []],
    ['a name too long, not its first 50 characters', `@${'m'.repeat(51)}`, []],
    ['a name of exactly 50 characters', `@${'m'.repeat(50)}`, ['m'.repeat(50)]],
    ['a URL', 'see https://medium.com/@kate and @liam', ['liam']],
  ])('handles %s', (_, text, expected) => {
    expect(extractMentions(text)).toEqual(expected);
  });

  describe('code', () => {
    it.each([
      ['inline code', 'run `@dave` but ask @frank', ['frank']],
      ['a double-backtick span', 'use ``a ` @erin`` then @gus', ['gus']],
      ['a fenced block', 'see\n```ts\n@gina\n```\nthen @hank', ['hank']],
      ['a tilde fence', '~~~\n@ivan\n~~~\n@jill', ['jill']],
      ['an indented fence', '   ```\n@kim\n   ```\n@lou', ['lou']],
      ['an unclosed fence, to the end', 'see\n```\n@ivan\n@jane', []],
      [
        'a fence closed only by its own character',
        '```\n@nina\n~~~\n@omar\n```\n@pia',
        ['pia'],
      ],
      ['a longer closing fence', '```\n@quin\n`````\n@rae', ['rae']],
      ['a lone backtick', 'a ` b @sam', ['sam']],
    ])('ignores mentions in %s', (_, text, expected) => {
      expect(extractMentions(text)).toEqual(expected);
    });
  });

  it('keeps the first `limit` names in order of appearance', () => {
    expect(extractMentions('@aaa @bbb @aaa @ccc @ddd', 2)).toEqual([
      'aaa',
      'bbb',
    ]);
  });
});

describe('addedMentions', () => {
  it('returns only names the previous version lacked, case-insensitively', () => {
    expect(addedMentions('hi @Alice', 'hi @alice and @bob', 10)).toEqual([
      'bob',
    ]);
  });

  it('applies the limit to the new version', () => {
    expect(addedMentions('', '@aaa @bbb @ccc', 2)).toEqual(['aaa', 'bbb']);
  });

  it('counts a name moved out of code as added', () => {
    expect(addedMentions('`@alice`', '@alice', 10)).toEqual(['alice']);
  });

  it('treats no previous version as empty', () => {
    expect(addedMentions(null, '@alice', 10)).toEqual(['alice']);
  });
});

describe('mentionText', () => {
  it('reads a post from its title and content', () => {
    expect(extractMentions(mentionText('@alice look', '@bob'))).toEqual([
      'alice',
      'bob',
    ]);
    expect(mentionText('Title', null)).toBe('Title\n');
  });
});
